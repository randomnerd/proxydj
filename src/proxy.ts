import debug from 'debug'
import execa from 'execa'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'

export interface ProxyInstanceConfig {
    user: string
    password?: string
    port: number | number[]
    rotationTime: number
    disabled?: boolean
    ipWhitelist?: string[]
}

export interface ProxyInstance {
    id: string
    proxy: execa.ExecaChildProcess,
    external: ExternalProxy
    rotationTimer?: NodeJS.Timer
    logger: debug.Debugger
    stopping?: boolean
    readonly config: ProxyInstanceConfig
}

export interface ProxyConfig {
    binaryPath: string
    logDir?: string
    useSSH?: boolean
    sshBinary?: string
    sshUser?: string
    sshHost?: string
    sshKey?: string
    externalIp?: string[]
    instances: ProxyInstanceConfig[]
    proxyList: string[]
    retryInterval?: number
}

export interface ExternalProxy {
    id: string
    disabled?: boolean
    host: string
    port: number | string
    inUse?: boolean
}

export enum ProxyEvent {
    proxySpawned = 'proxySpawned',
    proxyStopped = 'proxyStopped',
    externalReleased = 'externalReleased',
    externalOccupied = 'externalOccupied',
    externalAdded = 'externalAdded',
}

export class ProxyManager extends EventEmitter {
    logger = debug.default('ProxyManager')
    proxies: Record<string, ExternalProxy> = {}
    instances: Record<string, ProxyInstance> = {}

    constructor(private config: ProxyConfig) {
        super()
        debug.enable('ProxyManager,proxy:*')
        this.loadProxyList(this.config.proxyList)
        this.on(ProxyEvent.proxySpawned, id => this.onProxySpawned(id))
        this.on(ProxyEvent.proxyStopped, (id, out) => this.onProxyStopped(id, out))
        // this.on(ProxyEvent.externalReleased, id => this.releaseExternal(id))
        // this.on(ProxyEvent.externalOccupied, id => this.occupyExternal(id))
        const terminate = signal => {
            this.shutdown(signal)
                .then(() => {
                    this.logger(`Terminating main process`)
                    process.exit()
                })
                .catch(this.logger)
        }

        process.on('SIGINT', terminate)
        process.on('SIGTERM', terminate)
    }

    shutdown(signal?: NodeJS.Signals) {
        this.logger(`Shutdown initiated${signal ? ` by signal ${signal}` : ''}`)
        this.logger('Stopping all proxy instances...')
        const instances = Object.values(this.instances)
        return Promise.all(instances.map(i => this.stopInstance(i)))
    }

    start() {
        for (const instance of this.config.instances) {
            if (instance.disabled) continue
            this.spawnProxies(instance)
        }
    }

    spawnProxies(config: ProxyInstanceConfig): ProxyInstance[] {
        const ports = Array.isArray(config.port) ? config.port: [config.port]
        return ports.map(port => this.spawnProxy({ ...config, port }))
    }

    spawnProxy(config: ProxyInstanceConfig, prevExternalId?: string) {
        const external = this.findFreeExternalProxy(prevExternalId)
        if (!external) throw new Error('No free external proxy found')

        const id = randomBytes(4).toString('hex')
        const command = this.buildProxyCommand(config, external)
        this.logger(`Spawning proxy for ${config.user} @ port ${config.port}...\nCMD: ${command}`)
        const logger = debug(`proxy:${id}:${config.user}:${config.port}`)
        const proxy = execa.command(command, {
            all: true,
            reject: false,
            stripFinalNewline: false
        })
        proxy.then(out => this.emit(ProxyEvent.proxyStopped, id, out))
        this.instances[id] = { id, proxy, config, external, logger }

        if (proxy.pid) this.emit(ProxyEvent.proxySpawned, id)
        return this.instances[id]
    }

    onProxySpawned(id: string) {
        const instance = this.instances[id]
        if (!instance) throw new Error(`Instance ${id} not found`)
        this.setExternalStatus(instance.external.id, true)

        const { port, rotationTime } = instance.config
        const { port: extPort, host: extHost } = instance.external
        instance.logger(`Spawned proxy#${id} @ port ${port} -> ${extHost}:${extPort}`)
        if (rotationTime > 0) instance.rotationTimer = setTimeout(() => {
            instance.logger(`Rotation triggered`)
            this.rotateInstance(id)
        }, rotationTime * 1000)
    }

    stopInstance(instance: ProxyInstance) {
        return new Promise(resolve => {
            instance.stopping = true
            instance.proxy.finally(resolve)
            instance.proxy.cancel()
        })
    }

    async onProxyStopped(id: string, output: execa.ExecaReturnValue) {
        if (!this.instances[id]) throw new Error(`Instance ${id} not found`)
        const { config, external, logger, rotationTimer, stopping } = this.instances[id]
        this.setExternalStatus(external.id, false)
        if (rotationTimer) clearTimeout(rotationTimer)
        logger(`Proxy terminated${output?.all ? `, output:\n${output.all}` : ''}`)
        if (!stopping) {
            const retryTime = this.config.retryInterval || 1
            logger(`Unexpected shutdown, restarting in ${retryTime} second(s)...`)
            setTimeout(() => {
                    this.spawnProxy(config)
            }, retryTime * 1000)
        }
        delete this.instances[id]
    }

    setExternalStatus(id: string, inUse: boolean) {
        if (!this.proxies[id]) throw new Error(`ExternalProxy #${id} not found`)
        this.proxies[id].inUse = inUse
        this.emit(inUse ? ProxyEvent.externalOccupied : ProxyEvent.externalReleased, id)
    }

    async rotateInstance(id: string) {
        const instance = this.instances[id]
        if (!instance) throw new Error(`Instance ${id} not found`)
        await this.stopInstance(instance)
        await this.spawnProxy(instance.config, instance.external.id)
    }

    buildProxyCommand(config: ProxyInstanceConfig, external: ExternalProxy): string {
        const args = [
            this.config.binaryPath,
            'http',
            '-T tcp',
            `-p ${this.config.externalIp}:${config.port}`,
            `-P ${external.host}:${external.port}`,
        ]
        if (config.password) args.push(`-a ${config.user}:${config.password}:0:0:`)
        if (config.ipWhitelist?.length) config.ipWhitelist.forEach(ip => args.push(`--ip-allow ${ip}`))
        if (this.config.logDir) args.push(`--log ${this.config.logDir}/user-${config.user}-port-${config.port}.log`)
        if (this.config.useSSH) {
            return [
                this.config.sshBinary,
                `-i ${this.config.sshKey} -T`,
                `${this.config.sshUser}@${this.config.sshHost}`,
                ...args
            ].join(' ')
        }
        return args.join(' ')
    }

    loadProxyList(list: string[]): ExternalProxy[] {
        for (const item of list) {
            try {
                const [ host, port ] = item.split(':')
                const id = randomBytes(8).toString('hex')
                // this.logger(`Added external proxy ${host}:${port}`)
                this.proxies[id] = { id, host, port, inUse: false, disabled: false }
                this.emit(ProxyEvent.externalAdded, this.proxies[id])
            } catch (error) {
                this.logger(`Invalid proxy: ${item}`, error)
            }
        }
        return Object.values(this.proxies)
    }

    findFreeExternalProxy(excludeId?: string) {
        const proxies = Object
            .values(this.proxies)
            .filter(p => p.id !== excludeId && !p.inUse)
        if (!proxies.length) throw new Error('No free external proxies')
        const index = Math.round(Math.random() * (proxies.length - 1))
        return proxies[index]
    }
}
