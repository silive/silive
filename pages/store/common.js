const { request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")

function money(value) {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num.toFixed(2) : "0.00"
}

function statusText(status) {
  return {
    none: "无",
    preparing: "备货中",
    arrived_store: "已到店，待自提",
    picked_up: "已自提"
  }[status] || status || "-"
}

function levelText(level) {
  return {
    display: "展示点",
    pickup: "自提点",
    supplier: "供货点",
    partner: "合伙点"
  }[level] || "展示点"
}

function fetchStoreMe() {
  return request("/api/store/me")
}

function ensureStorePage(page, callback) {
  applyTheme(page)
  fetchStoreMe().then(data => {
    if (!data.bound) {
      wx.showModal({
        title: "暂未绑定门店",
        content: "当前手机号没有绑定合作门店，请联系管理员在后台设置门店负责人手机号。",
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }
    page.setData({
      storeInfo: {
        ...data.storeInfo,
        levelText: levelText(data.storeInfo.level)
      },
      stats: data.stats || {}
    })
    if (callback) callback(data)
  }).catch(error => {
    wx.showToast({ title: error.message || "门店身份读取失败", icon: "none" })
  })
}

module.exports = {
  money,
  statusText,
  levelText,
  fetchStoreMe,
  ensureStorePage
}
