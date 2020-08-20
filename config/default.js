module.exports = {
    proxyConfig: {
        useSSH: process.env.USE_SSH === undefined
            ? false
            : Number(process.env.USE_SSH) === 1,
        sshBinary: process.env.SSH_BINARY || '/usr/bin/ssh',
        sshHost: process.env.SSH_HOST || '45.76.78.165',
        sshUser: process.env.SSH_USER || 'randomnerd',
        sshKey: process.env.SSH_KEY || `/home/randomnerd/.ssh/id_rsa`,
        binaryPath: process.env.PROXY_BIN || 'proxy',
        logDir: process.env.LOG_DIR || 'logs',
        retryInterval: 1,
        externalIp: process.env.EXTERNAL_IP || '0.0.0.0',
        instances: [{
            user: 'new',
            // password: 'test',
            port: [31111, 31112],
            rotationTime: 60, // seconds
        }],
        proxyList: [
            '190.2.153.140:35490',
            '190.2.153.140:35491',
            '190.2.153.140:35492',
            '190.2.153.140:35493',
            '190.2.153.140:35494',
            '190.2.153.140:35495',
            '190.2.153.140:35496',
            '190.2.153.140:35497',
            '190.2.153.140:35498',
            '190.2.153.140:35499',
            '190.2.153.140:35725',
            '190.2.153.140:35726',
            '190.2.153.140:35727',
            '190.2.153.140:35728',
            '190.2.153.140:35729',
        ]
    },
}
