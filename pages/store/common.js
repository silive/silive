const { request } = require("../../utils/api")
const { ensureAuthenticated } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")

function money(value) {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num.toFixed(2) : "0.00"
}

function statusText(status) {
  return {
    none: "无",
    preparing: "配送到门店中",
    arrived_store: "已到店，待自提",
    ready_for_pickup: "已到店，待自提",
    arrived: "已到店，待自提",
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
  ensureAuthenticated({ source: "store-page" }).then(() => fetchStoreMe()).then(data => {
    if (!data.bound) {
      wx.showModal({
        title: "暂未绑定门店",
        content: "当前手机号没有绑定合作门店，请联系管理员在后台设置门店负责人手机号。",
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }
    const permissions = Array.isArray(data.permissions) ? data.permissions : []
    const has = key => permissions.includes(key)
    page.setData({
      storeInfo: {
        ...data.storeInfo,
        levelText: levelText(data.storeInfo.level),
        role: data.role || data.storeInfo?.storeRole || "",
        storeRoleText: data.storeInfo?.storeRoleText || ""
      },
      stats: data.stats || {},
      role: data.role || "",
      permissions,
      canStoreCode: has("store.code"),
      canReferralOrders: has("referral.view"),
      canPickupOrders: has("pickup.view"),
      canNotifyPickup: has("pickup.notify"),
      canVerifyPickup: has("pickup.verify"),
      canViewEarnings: has("earning.view") || has("settlement.view"),
      canViewSettlements: has("settlement.view"),
      canManageMembers: has("member.manage")
    })
    if (callback) callback(data)
  }).catch(error => {
    const expired = Number(error.statusCode || 0) === 401 || /登录|授权/.test(error.message || "")
    wx.showModal({
      title: expired ? "登录状态已过期" : "门店身份读取失败",
      content: expired ? "请重新登录后进入门店中心。" : (error.message || "请稍后重试"),
      showCancel: false,
      success: () => wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/profile" }) })
    })
  })
}

module.exports = {
  money,
  statusText,
  levelText,
  fetchStoreMe,
  ensureStorePage
}
