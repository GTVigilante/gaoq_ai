# ZAP Packaged Scan 启动后加载固定 HTTP Sender 脚本；不得输出环境变量。
def zap_started(zap, target):
    zap.script.load(
        'gaoq-exact-auth-header.js',
        'httpsender',
        'Graal.js',
        '/zap/gaoq/exact-auth-header.js',
    )
    zap.script.enable('gaoq-exact-auth-header.js')
