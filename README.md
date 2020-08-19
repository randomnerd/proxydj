# Proxy DJ

## Installation
#### With source code
- Install [node.js](https://nodejs.org/en/download/)
- Clone this repo
- Execute in repo directory:
```bash
npm i
npm run build
npm start
```
#### With docker
- Install [docker](https://www.docker.com/get-started)
- Clone this repo
- Execute in repo directory:

```bash
docker build . -t proxy-djay
docker run --name proxy-djay --restart unless-stopped -p 31313:31313 proxy-djay
```

## Configuration
Edit `./config/default.js`
```javascript
module.exports = {
    // Indicates if we should use ssh connection
    // to machine running the proxy
    useSSH: false,
    // Path to the SSH Client binary
    sshBinary: '/usr/bin/ssh',
    // IP or Domain name of the proxy host
    sshHost: '127.0.0.1',
    // Username to use when connecting to the proxy host
    sshUser: 'root',
    // Path to the SSH private key for the proxy host
    sshKey: '/path/to/id_rsa',
    // Path to the proxy binary
    binaryPath: '/usr/bin/proxy',
    // Path to use for the log file
    logFile: '/path/to/file.log',
    // External IP to bind client ports at
    // (use 0.0.0.0 to bind at all addresses at once)
    externalIp: '0.0.0.0', 
    // Client ports configuration
    instances: [{
        // Username for authentication & logging
        user: 'username',
        // Password for user authentication
        // Can be omitted to disable auth
        password: 'w00t',
        // Port for incoming client connections
        port: 31337,
        // Interval (in seconds) for proxy switching
        rotationTime: 60,
        // Array of IPs to allow client connections from
        // All IPs are allowed if omitted
        ipWhitelist: ['127.0.0.1']
    }],
    // List of external proxies 
    proxyList: [
        '127.0.0.1:3128'
    ]
    // P.S.: Most of those config params can be supplied
    // via ENV variables, see the config file for their names
}
```
