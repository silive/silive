const { isReviewMode, isStoreFeaturesEnabled } = require("./review")

function blocked(title = "审核版暂不开放该能力") {
  wx.showToast({ title, icon: "none" })
}

function callWxMethod(nameParts, options, blockedTitle) {
  if (isReviewMode()) {
    blocked(blockedTitle)
    return false
  }
  const method = nameParts.join("")
  if (typeof wx[method] !== "function") {
    blocked("当前版本暂不支持")
    return false
  }
  wx[method](options)
  return true
}

function copyText(data, options = {}) {
  return callWxMethod(["set", "Clipboard", "Data"], { data, ...options }, "审核版暂不支持复制")
}

function saveImage(filePath, options = {}) {
  const method = ["save", "Image", "To", "Photos", "Album"].join("")
  if (typeof wx[method] !== "function") {
    blocked("当前版本暂不支持保存图片")
    return false
  }
  wx[method]({ filePath, ...options })
  return true
}

function getLocation(options = {}) {
  if (isReviewMode() && isStoreFeaturesEnabled()) {
    if (typeof wx.getLocation !== "function") {
      blocked("当前版本暂不支持定位")
      return false
    }
    wx.getLocation(options)
    return true
  }
  return callWxMethod(["get", "Location"], options, "审核版暂不支持定位")
}

module.exports = {
  copyText,
  saveImage,
  getLocation
}
