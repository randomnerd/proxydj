import debug from 'debug'
import execa from 'execa'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'
import path from 'path'

export interface ProxyInstanceConfig {
    user: string
    password?: string
    port: number | number[]
    rotationTime: number
    disabled?: boolean
    ipWhitelist?: string[]
    maxConn?: number
    expires?: number | string
}

export class ProxyInstance {
    id: string
    proxy: execa.ExecaChildProcess
    external: ExternalProxy
    rotationTimer?: NodeJS.Timer
    logger: debug.Debugger
    stopping?: boolean
    readonly config: ProxyInstanceConfig
    get pidFilename(): string {
        return `${this.id}.pid`
    }

    get logFilename(): string {
        return `${this.id}.log`
    }

    writePidFile(dir: string) {
        try {
            writeFileSync(
                path.join(dir, this.pidFilename),
                this.proxy.pid.toString()
            )
            return true
        } catch {
            return false
        }
    }

    readPidFile(dir: string) {
        const pidFile = path.join(dir, this.pidFilename)
        if (!existsSync(pidFile)) return
        try {
            const pid = Number(readFileSync(pidFile).toString())
            if (!isNaN(pid)) process.kill(pid, 'SIGINT')
            return true
        } catch {
            unlinkSync(pidFile)
            return false
        }
    }

    constructor(initial?: Partial<ProxyInstance>) {
        if (initial) Object.assign(this, initial)
    }
}

export interface ProxyConfig {
    binaryPath: string
    logDir?: string
    tmpDir: string
    useSSH?: boolean
    sshBinary?: string
    sshUser?: string
    sshHost?: string
    sshKey?: string
    externalIp?: string[]
    instances: ProxyInstanceConfig[]
    proxyList: ExternalProxy[]
    retryInterval?: number
}

export interface ExternalProxy {
    id: string
    disabled?: boolean
    type?: ProxyType
    host: string
    port: number | string
    inUse?: boolean
}

export enum ProxyType {
    SOCKS = 'socks',
    HTTP = 'http',
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
            if (instance.expires && new Date(instance.expires) < new Date()) {
                this.logger(`Config ${instance.user} expired`)
                continue
            }
            this.spawnProxies(instance)
        }
    }

    spawnProxies(config: ProxyInstanceConfig) {
        const ports = Array.isArray(config.port) ? config.port: [config.port]
        return ports.map(port => this.spawnProxy({ ...config, port }))
    }

    spawnProxy(config: ProxyInstanceConfig, prevExternalId?: string) {
        const id = `user-${config.user}-port-${config.port}`
        let external
        if (config.rotationTime > 0) {
            external = this.findFreeExternalProxy(prevExternalId)
            if (!external) throw new Error('No free external proxy found')
        }
        const command = this.buildProxyCommand(config, external)
        this.logger(`Spawning proxy for ${config.user} @ port ${config.port}...\nCMD: ${command}`)
        const logger = debug(`proxy:${id}`)
        const instance = new ProxyInstance({ id, config, external, logger })
        instance.readPidFile(this.config.tmpDir)
        const proxy = execa.command(command, {
            all: true,
            reject: false,
            stripFinalNewline: false
        })
        instance.proxy = proxy
        proxy.then(out => this.emit(ProxyEvent.proxyStopped, id, out))
        this.instances[id] = instance

        if (proxy.pid) this.emit(ProxyEvent.proxySpawned, id)
        return this.instances[id]
    }

    whiteListFilePath(config: ProxyInstanceConfig): string {
        return path.join(this.config.tmpDir, `proxy-whitelist-${config.user}-${config.port}.tmp`)
    }

    makeWhitelistFile(config: ProxyInstanceConfig) {
        if (!config.ipWhitelist?.length) return
        const ipWhitelist = config.ipWhitelist.join('\n')
        const filePath = this.whiteListFilePath(config)
        writeFileSync(filePath, ipWhitelist)
        this.logger(`Wrote whiteList file for ${config.user} @ port ${config.port}: ${filePath}`)
        return filePath
    }

    removeWhitelistFile(config: ProxyInstanceConfig) {
        try { unlinkSync(this.whiteListFilePath(config)) } catch {}
    }

    onProxySpawned(id: string) {
        const instance = this.instances[id]
        if (!instance) throw new Error(`Instance ${id} not found`)
        instance.writePidFile(this.config.tmpDir)

        const { port, rotationTime } = instance.config
        if (!instance.external) return
        this.setExternalStatus(instance.external.id, true)
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
            instance.proxy?.finally(resolve)
            instance.proxy?.cancel()
        })
    }

    async onProxyStopped(id: string, output: execa.ExecaReturnValue) {
        if (!this.instances[id]) throw new Error(`Instance ${id} not found`)
        const { config, external, logger, rotationTimer, stopping } = this.instances[id]
        this.instances[id].readPidFile(this.config.tmpDir)
        this.setExternalStatus(external.id, false)
        if (rotationTimer) clearTimeout(rotationTimer)
        if (config.ipWhitelist?.length) this.removeWhitelistFile(config)
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

    buildProxyCommand(config: ProxyInstanceConfig, external?: ExternalProxy): string {
        const args = [
            this.config.binaryPath,
            'sps',
            `-S ${external?.type ?? 'http'}`,
            '-T tcp',
            `-p ${this.config.externalIp}:${config.port}`,
        ]
        if (external) {
            args.push(`-P ${external.host}:${external.port}`)
            // args.push('--always')
        } else {
            for (const ext of Object.values(this.proxies)) {
                if (ext.type !== ProxyType.HTTP) continue
                args.push(`-P ${ext.host}:${ext.port}`)
                //
            }
            // args.push('--lb-hashtarget')
            args.push('--lb-method=hash')
        }
        if (typeof config.maxConn === 'number') args.push(`--max-conns ${config.maxConn}`)
        if (config.password) args.push(`-a ${config.user}:${config.password}:0:0:`)
        // if (config.ipWhitelist?.length) config.ipWhitelist.forEach(ip => args.push(`--ip-allow ${ip}`))
        if (config.ipWhitelist?.length) args.push(`--ip-allow ${this.makeWhitelistFile(config)}`)
        const filename = `user-${config.user}-port-${config.port}`
        if (this.config.logDir) args.push(`--log ${this.config.logDir}/${filename}.log`)
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

    loadProxyList(list: ExternalProxy[]): ExternalProxy[] {
        for (const item of list) {
            try {
                const proxy = {
                    ...item,
                    id : item.id ?? randomBytes(8).toString('hex'),
                    type: item.type ?? ProxyType.HTTP,
                    inUse: false
                }
                this.proxies[proxy.id] = proxy
                this.emit(ProxyEvent.externalAdded, proxy)
            } catch (error) {
                this.logger(`Invalid proxy`, item, error)
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
