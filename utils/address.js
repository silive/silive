function formatWechatAddress(address = {}) {
  return [
    address.provinceName,
    address.cityName,
    address.countyName,
    address.detailInfo
  ].filter(Boolean).join(" ")
}

function addressErrorMessage(error = {}) {
  const errMsg = String(error.errMsg || "")
  const errCode = error.errCode || error.errno || ""
  const text = `${errMsg} ${errCode}`.toLowerCase()
  if (text.includes("cancel")) return "未选择地址，可手动填写"
  if (text.includes("deny") || text.includes("auth")) return "请在微信设置中允许使用通讯地址，或手动填写"
  if (text.includes("permission") || text.includes("scope") || text.includes("no permission")) return "当前小程序暂不支持微信地址，请手动填写"
  return "无法打开微信地址，请手动填写"
}

function chooseWechatAddress() {
  return new Promise((resolve, reject) => {
    if (!wx.chooseAddress) {
      reject({ errMsg: "wx.chooseAddress unavailable" })
      return
    }
    wx.chooseAddress({
      success: resolve,
      fail: error => {
        console.warn("[address] chooseAddress fail", {
          errMsg: error && error.errMsg,
          errCode: error && (error.errCode || error.errno)
        })
        reject(error)
      }
    })
  })
}

module.exports = {
  chooseWechatAddress,
  formatWechatAddress,
  addressErrorMessage
}
