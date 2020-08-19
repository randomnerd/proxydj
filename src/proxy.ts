import debug from 'debug'
import { EventEmitter } from 'events'
import execa from 'execa'
import { randomBytes } from 'crypto'
import path from 'path'

export interface ProxyInstanceConfig {
    user: string
    password?: string
    port: number
    rotationTime: number
    disabled?: boolean
    ipWhitelist?: string[]
}

export interface ProxyInstance {
    proxy: execa.ExecaChildProcess,
    external?: ExternalProxy
    lastExternal?: ExternalProxy
    rotationTimer?: NodeJS.Timer
    logger: debug.Debugger
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
}

export interface ExternalProxy {
    id?: string
    disabled?: boolean
    host: string
    port: number
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
    proxies: ExternalProxy[] = []
    instances: ProxyInstance[] = []
    logger = debug.default('ProxyManager:log')

    constructor(private config: ProxyConfig) {
        super()
        debug.enable('ProxyManager:*')
        this.loadProxyList(this.config.proxyList)
        process.on('SIGINT', () => {
            this.shutdown()
                .then(() => process.exit())
                .catch(this.logger)
        })
        process.on('SIGTERM', () => {
            this.shutdown()
                .then(() => process.exit())
                .catch(this.logger)
        })
    }

    shutdown() {
        return Promise.all(this.instances.map(i => this.stopInstance(i)))
    }

    start() {
        for (const instance of this.config.instances) {
            if (instance.disabled) continue
            this.spawnProxy(instance)
        }
    }

    async spawnProxy(config: ProxyInstanceConfig, prevExternal?: ExternalProxy) {
        this.logger(`Spawning proxy for ${config.user} @ port ${config.port}...`)
        const external = this.findFreeExternalProxy(prevExternal)
        if (!external) {
            const error = new Error('No free external proxy found')
            this.logger(error)
            return error
        }
        const command = this.buildProxyCommand(config, external)
        this.logger(command)
        external.inUse = true
        this.emit(ProxyEvent.externalOccupied, external, config)
        const proxy = execa.command(command, { all: true })
        this.onProxySpawned(null, proxy, config, external)
    }

    onProxySpawned(err: Error | null, proxy: execa.ExecaChildProcess, config: ProxyInstanceConfig, external: ExternalProxy) {
        const instance: ProxyInstance = { proxy, config, external, logger: this.logger.extend(`proxy:${config.user}:${proxy.pid}`) }
        if (err) {
            instance.logger(`Error spawning proxy`, err)
            external.inUse = false
            this.emit(ProxyEvent.externalReleased, external)
            setTimeout(() => this.spawnProxy(config), 10 * 1000)
            return
        }
        proxy.catch().then(value => this.onProxyStopped(instance, value))
        proxy.on('exit', () => this.onProxyStopped(instance))
        instance.logger(`Spawned proxy @ port ${config.port} -> ${external.host}:${external.port}`)
        if (!isNaN(config.rotationTime)) instance.rotationTimer = setTimeout(() => {
            if (instance.rotationTimer) clearTimeout(instance.rotationTimer)
            instance.logger(`Rotation triggered`)
            this.rotateInstance(instance)
        }, config.rotationTime * 1000)

        this.instances.push(instance)
        this.emit(ProxyEvent.proxySpawned, instance)
    }

    stopInstance(instance: ProxyInstance) {
        return new Promise((resolve, reject) => {
            instance.proxy.catch(reject).then(resolve)
            instance.proxy.cancel()
        })
    }

    async onProxyStopped(instance: ProxyInstance, output?: execa.ExecaReturnValue, error?: Error) {
        const instanceIdx = this.instances.indexOf(instance)
        if (instanceIdx === -1)  {
            const ext = this.proxies.find(p => p.id === instance.external?.id)
            if (ext) ext.inUse = false
            instance.logger(`Proxy terminated, output:\n${output?.all}`)
        }
        this.instances.splice(instanceIdx, 1)
        if (error) return instance.logger(`Error stopping proxy`, error)

        if (instance.external) this.releaseExternal(instance.external)
        instance.lastExternal = instance.external
        instance.external = undefined
        if (instance.rotationTimer) clearInterval(instance.rotationTimer)
        this.emit(ProxyEvent.proxyStopped, instance)
    }

    releaseExternal(external: ExternalProxy) {
        external.inUse = false
        this.emit(ProxyEvent.externalReleased, external)
    }

    rotateInstance(instance: ProxyInstance) {
        return this.stopInstance(instance)
            .then(() => this.spawnProxy(instance.config, instance.lastExternal))
            .catch(instance.logger)
    }

    buildProxyCommand(config: ProxyInstanceConfig, external: ExternalProxy): string {
        const args = [
            this.config.binaryPath,
            'http',
            '-T tcp',
            `-p ${this.config.externalIp}:${config.port}`,
            config.password
                ? `-a ${config.user}:${config.password}:0:0:http://${external.host}:${external.port}`
                : `-P ${external.host}:${external.port}`,
        ]
        if (config.ipWhitelist?.length) config.ipWhitelist.forEach(ip => args.push(`--ip-allow ${ip}`))
        if (this.config.logDir) args.push(`--log ${path.join(this.config.logDir, `user-${config.user}.log`)}`)
        if (this.config.useSSH) {
            return [
                this.config.sshBinary,
                `-i ${this.config.sshKey}`,
                `${this.config.sshUser}@${this.config.sshHost}`,
                this.config.binaryPath,
                args
            ].join(' ')
        }
        return args.join(' ')
    }

    loadProxyList(list: string[]): ExternalProxy[] {
        const proxyList: ExternalProxy[] = []
        for (const item of list) {
            if (!item.split(':').length) {
                this.logger(new Error(`Invalid proxy: ${item}`))
                continue
            }
            const [ host, port ] = item.split(':')

            const proxy: ExternalProxy = {
                host,
                port: Number(port),
                inUse: false,
                disabled: false
            }
            if (this.findProxy(proxy)) continue
            proxy.id = randomBytes(8).toString('hex')
            proxyList.push(proxy)
            this.proxies.push(proxy)
            this.emit(ProxyEvent.externalAdded, proxy)
        }
        return proxyList
    }

    findProxy(config: ExternalProxy) {
        return this.proxies.find(proxy => {
            if (config.id && proxy.id !== config.id) return false
            if (proxy.host !== config.host) return false
            return proxy.port === config.port
        })
    }

    findFreeExternalProxy(exclude?: ExternalProxy) {
        if (exclude && this.proxies.length < 2) throw new Error(`No external proxy available`)
        const randomIndex = () => Math.floor(Math.random() * this.proxies.length)
        let proxy
        while (!proxy || proxy.inUse || proxy.id === exclude?.id) proxy = this.proxies[randomIndex()]
        return proxy
    }
}
