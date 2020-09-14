module.exports = {
    proxyConfig: {
        useSSH: process.env.USE_SSH === undefined
            ? false
            : Number(process.env.USE_SSH) === 1,
        sshBinary: process.env.SSH_BINARY || '/usr/bin/ssh',
        sshHost: process.env.SSH_HOST || '45.76.78.165',
        sshUser: process.env.SSH_USER || 'randomnerd',
        sshKey: process.env.SSH_KEY || `${process.env.HOME}/.ssh/id_rsa`,
        binaryPath: process.env.PROXY_BIN || 'proxy',
        logDir: process.env.LOG_DIR || '/tmp',
        tmpDir: process.env.TMP_DIR || '/tmp',
        retryInterval: 1,
        externalIp: process.env.EXTERNAL_IP || '0.0.0.0',
        instances: [{
            user: 'new',
            // password: 'test',
            port: [31111, 31112],
            maxConn: 10,
            rotationTime: 10, // seconds
            expires: '2020-09-14T18:10:47.612Z'
        }],
        proxyList: [
            { id: 'port1', host: '190.2.153.140', port: 35490 },
            { id: 'port2', host: '190.2.153.140', port: 35491 },
            { id: 'port3', host: '190.2.153.140', port: 35492 },
            { id: 'port4', host: '190.2.153.140', port: 35493 },
            { id: 'port5', host: '190.2.153.140', port: 35494 },
            { id: 'port6', host: '190.2.153.140', port: 35495 },
            { id: 'port7', host: '190.2.153.140', port: 35496 },
            { id: 'port8', host: '190.2.153.140', port: 35497 },
            { id: 'port9', host: '190.2.153.140', port: 35498 },
            { id: 'port10', host: '190.2.153.140', port: 35499 },
            { id: 'port11', host: '190.2.153.140', port: 35725 },
            { id: 'port12', host: '190.2.153.140', port: 35726 },
            { id: 'port13', host: '190.2.153.140', port: 35727 },
            { id: 'port14', host: '190.2.153.140', port: 35728 },
            { id: 'port15', host: '190.2.153.140', port: 35729 },
        ]

    },
}
