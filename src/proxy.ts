import pm2, { Proc } from 'pm2'
import debug from 'debug'
import path from 'path'
import { generate as randomString } from 'randomstring'
import { EventEmitter } from 'events'

export interface ProxyInstanceConfig {
    user: string
    password?: string
    port: number
    rotationTime: number
    disabled?: boolean
    ipWhitelist?: string[]
}

export interface ProxyInstance {
    proxy: Proc,
    external?: ExternalProxy
    lastExternal?: ExternalProxy
    rotationTimer?: NodeJS.Timer
    readonly config: ProxyInstanceConfig
}

export interface ProxyConfig {
    binaryPath: string
    logFile?: string
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
    pmConnected = 'pmConnected',
    pmDisconnected = 'pmDisconnected',
    proxySpawned = 'proxySpawned',
    proxyStopped = 'proxyStopped',
    externalReleased = 'externalReleased',
    externalOccupied = 'externalOccupied',
    externalAdded = 'externalAdded',
}

export class ProxyManager extends EventEmitter {
    pmConnected = false
    proxies: ExternalProxy[] = []
    instances: ProxyInstance[] = []
    logger = debug.default('ProxyManager:log')

    constructor(private config: ProxyConfig) {
        super()
        debug.enable('ProxyManager:*')
        this.loadProxyList(this.config.proxyList)
        pm2.connect(true, e => this.onPMConnect(e))
    }

    onPMConnect(err: Error) {
        if (err) {
            this.pmConnected = false
            return this.logger(err)
        }
        this.pmConnected = true
        this.logger('PM2 connected')
        this.emit(ProxyEvent.pmConnected)
    }

    start() {
        if (!this.pmConnected) throw new Error('PM2 is not connected')
        for (const instance of this.config.instances) {
            if (instance.disabled) continue
            this.spawnProxy(instance)
        }
    }

    spawnProxy(config: ProxyInstanceConfig, prevExternal?: ExternalProxy) {
        this.logger(`Spawning proxy for ${config.user} @ port ${config.port}...`)
        const external = this.findFreeExternalProxy(prevExternal)
        if (!external) {
            const error = new Error('No free external proxy found')
            this.logger(error)
            return error
        }
        const options = this.buildProxyOptions(config, external)
        this.logger(`${options.script} ${(options.args as string[]).join(' ')}`)
        external.inUse = true
        this.emit(ProxyEvent.externalOccupied, external, config)
        pm2.start(options, (err, proxy) => this.onProxySpawned(err, proxy, config, external))
        // this.onProxySpawned(null, <Proc>{}, config, external)
    }

    onProxySpawned(err: Error | null, proxy: Proc, config: ProxyInstanceConfig, external: ExternalProxy) {
        if (err) {
            this.logger(`Error spawning proxy for ${config.user}`, err)
            setTimeout(() => this.spawnProxy(config), 10 * 1000)
            external.inUse = false
            this.emit(ProxyEvent.externalReleased, external)
        }
        // this.logger(proxy[0])
        this.logger(`Spawned proxy for ${config.user} @ port ${config.port} -> ${external.host}:${external.port} (ID ${proxy[0].pm_id})`)
        const instance: ProxyInstance = { proxy, config, external }
        if (!isNaN(config.rotationTime)) instance.rotationTimer = setTimeout(() => {
            if (instance.rotationTimer) clearTimeout(instance.rotationTimer)
            this.logger(`Rotation triggered for proxy ${config.user}`)
            this.rotateInstance(instance)
        }, config.rotationTime * 1000)

        // setInterval(() => {
        //     this.logger(proxy[0])
        // }, 10000)
        this.instances.push(instance)
        this.emit(ProxyEvent.proxySpawned, instance)
    }

    stopInstance(instance: ProxyInstance, attempts = 10) {
        const retryStop = (instance: ProxyInstance, attempts = 10) => {
            return new Promise((resolve, reject) => {
                pm2.stop(instance.proxy[0].name, e => {
                    if (!e) return resolve(this.onProxyStopped(instance, e))
                    if (attempts === 0) reject(new Error('Retry attempts exhausted'))
                    setTimeout(() => this.stopInstance(instance)
                        .catch(() => retryStop(instance, attempts - 1))
                        .then(resolve), 1000)
                })
            })
        }
        return retryStop(instance, attempts)
    }

    onProxyStopped(instance: ProxyInstance, error?: Error) {
        const { proxy, config, external, rotationTimer } = instance
        if (error) {
            this.logger(`Error stopping proxy for ${config.user}`, error)
            return
        }
        if (external) this.releaseExternal(external)
        instance.lastExternal = external
        instance.external = undefined
        if (rotationTimer) clearInterval(rotationTimer)
        this.logger(`Stopped proxy for ${config.user} @ port ${config.port} (ID ${proxy[0].pm_id})`)
        this.emit(ProxyEvent.proxyStopped, instance)
    }

    releaseExternal(external: ExternalProxy) {
        external.inUse = false
    }

    rotateInstance(instance: ProxyInstance) {
        return this.stopInstance(instance)
            .then(() => this.spawnProxy(instance.config, instance.lastExternal))
            .catch(this.logger)
    }

    buildProxyOptions(config: ProxyInstanceConfig, external: ExternalProxy): pm2.StartOptions {
        const args = [
            'http',
            `-p ${this.config.externalIp}:${config.port}`,
            `--log ${config.user}.log`,
            config.password
                ? `-a ${config.user}:${config.password}:0:0:http://${external.host}:${external.port}`
                : `-P ${external.host}:${external.port}`,
        ]
        if (config.ipWhitelist?.length) config.ipWhitelist.forEach(ip => {
            args.push(`--ip-allow ${ip}`)
        })
        const options: pm2.StartOptions = {
            args,
            force: true,
            name: config.user,
            min_uptime: 30 * 1000,
            interpreter: 'none',
            script: this.config.binaryPath,
            output: `proxy-${config.user}-pm2.log`,
            error: `proxy-${config.user}-pm2.log`,
        }
        if (this.config.useSSH) {
            const proxyExecString = [
                this.config.binaryPath,
                ...options.args as string[]
            ].join(' ')
            options.script = this.config.sshBinary
            options.args = [
                `-i ${this.config.sshKey}`,
                `${this.config.sshUser}@${this.config.sshHost}`,
                proxyExecString
            ]
        }
        return options
    }

    loadProxyList(list: string[]): ExternalProxy[] {
        const proxyList: ExternalProxy[] = []
        for (const item of list) {
            if (!item.split(':').length) {
                this.logger(new Error(`Invalid proxy: ${item}`))
                continue
            }
            const [ host, port ] = item.split(':')

            const proxy = {
                host,
                port: Number(port),
                inUse: false,
                disabled: false
            } as ExternalProxy
            if (this.findProxy(proxy)) continue
            proxy.id = randomString(10)
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
