import config from 'config'
import { ProxyManager } from './proxy'

const manager = new ProxyManager(config.get('proxyConfig'))
manager.start()
