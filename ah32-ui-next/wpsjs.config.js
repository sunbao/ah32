/**
 * WPS 插件配置文件
 * 用于 wpsjs debug 命令
 */
module.exports = {
  // 插件类型
  type: 'web',
  // 入口文件
  entry: 'taskpane.html',
  // 开发服务器配置
  server: {
    // Must match taskpane.html's dev loader (http://127.0.0.1:3889).
    // wpsjs debug will rewrite package.json scripts to run Vite on this port.
    port: 3889
  },
  // 构建输出目录
  outputDir: 'wps-plugin'
}
