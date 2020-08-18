import config from 'config'
import { ProxyEvent, ProxyManager } from './proxy'

const manager = new ProxyManager(config.get('proxyConfig'))
manager.on(ProxyEvent.pmConnected, () => manager.start())
