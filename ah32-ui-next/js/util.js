// WPS 枚举值定义
var WPS_Enum = {
  msoCTPDockPositionLeft: 0,
  msoCTPDockPositionRight: 2
}

// 获取当前 URL 路径
function GetUrlPath() {
  let e = document.location.toString()
  return -1 != (e = decodeURI(e)).indexOf("/") && (e = e.substring(0, e.lastIndexOf("/"))), e
}

// 打开任务窗格
function OpenTaskPane(htmlPath, title) {
  let tsId = window.Application.PluginStorage.getItem("ah32_taskpane_id")
  if (!tsId) {
    let tskpane = window.Application.CreateTaskPane(htmlPath)
    let id = tskpane.ID
    window.Application.PluginStorage.setItem("ah32_taskpane_id", id)
    tskpane.Visible = true
    return tskpane
  } else {
    let tskpane = window.Application.GetTaskPane(tsId)
    tskpane.Visible = !tskpane.Visible
    return tskpane
  }
}
