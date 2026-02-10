// 阿蛤 WPS 加载项入口文件

// Ribbon 回调函数统一挂载到 window.ribbon 对象
console.log('[WPS插件] 开始定义 window.ribbon 对象...')

try {
  window.ribbon = {
  // 加载项初始化
  OnAddinLoad: function(ribbonUI) {
    if (typeof (window.Application.ribbonUI) != "object") {
      window.Application.ribbonUI = ribbonUI
    }

    if (typeof (window.Application.Enum) != "object") {
      window.Application.Enum = WPS_Enum
    }

    // 初始化任务窗格 ID
    window.Application.PluginStorage.setItem("ah32_taskpane_id", "")

    console.log('阿蛤 加载项已加载')

    return true
  },

  // Ribbon 按钮点击处理
  OnAction: function(control) {
    const eleId = control.Id
    switch (eleId) {
      case "btnOpenPanel":
        // 打开任务窗格
        const taskpane = OpenTaskPane(GetUrlPath() + "/taskpane.html", "阿蛤 智能助手")
        console.log('[WPS插件] 任务窗格已打开')
        break
    }
    return true
  },

  // 获取按钮图标
  GetImage: function(control) {
    var baseUrl = ""
    try { baseUrl = String(GetUrlPath() || "") } catch (e) { baseUrl = "" }

    const eleId = control.Id
    var rel = "assets/newFromTemp.svg"
    switch (eleId) {
      case "btnOpenPanel":
        rel = "assets/1.svg"
        break
      case "btnReadDoc":
        rel = "assets/2.svg"
        break
      case "btnWriteDoc":
        rel = "assets/3.svg"
        break
      default:
        rel = "assets/newFromTemp.svg"
        break
    }

    // Some WPS builds fail to load Ribbon images from `file://` URLs.
    // Use absolute URLs only for http/https dev-server; otherwise return a relative path.
    if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
      return baseUrl.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "")
    }
    return rel.replace(/^\/+/, "")
  },

  // 按钮启用状态
  OnGetEnabled: function(control) {
    return true
  },

  // 按钮可见状态
  OnGetVisible: function(control) {
    return true
  },

  // 按钮标签
  OnGetLabel: function(control) {
    const eleId = control.Id
    switch (eleId) {
      case "btnOpenPanel":
        return "打开助手"
      default:
        return ""
    }
  }
};

  console.log('[WPS插件] ✅ window.ribbon 对象定义完成')
  console.log('[WPS插件] ribbon 对象可用性:', !!window.ribbon)
  console.log('[WPS插件] ribbon 方法数量:', Object.keys(window.ribbon).length)
  
} catch (error) {
  console.error('[WPS插件] 定义 window.ribbon 对象失败:', error)
}

// 为前端提供全局刷新函数
window.refreshDocumentList = function() {
  console.log('[WPS插件] 前端调用刷新文档列表')

  // 方式1: 存储刷新命令到 PluginStorage
  try {
    window.Application.PluginStorage.setItem('ah32_refresh_command', JSON.stringify({
      timestamp: Date.now(),
      source: 'wps-plugin'
    }))
    console.log('[WPS插件] ✅ 刷新命令已存储到 PluginStorage')
  } catch (error) {
    console.warn('[WPS插件] 刷新命令存储失败:', error)
  }

  // 方式2: 尝试使用 postMessage
  try {
    if (window.parent && typeof window.parent.postMessage === 'function') {
      window.parent.postMessage({
        type: 'RefreshDocumentList',
        data: { source: 'wps-plugin', timestamp: Date.now() }
      }, '*')
      console.log('[WPS插件] ✅ 刷新消息已发送')
    }
  } catch (error) {
    console.warn('[WPS插件] postMessage 发送失败:', error)
  }
}
