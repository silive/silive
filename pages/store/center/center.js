const { ensureStorePage } = require("../common")

Page({
  data: {
    storeInfo: null,
    stats: {},
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    ensureStorePage(this)
  },

  goReferralOrders() {
    wx.navigateTo({ url: "/pages/store/referral-orders/referral-orders" })
  },

  goStoreCode() {
    wx.navigateTo({ url: "/pages/store/code/code" })
  },

  goPickupOrders() {
    wx.navigateTo({ url: "/pages/store/pickup-orders/pickup-orders" })
  },

  goVerify() {
    wx.navigateTo({ url: "/pages/store/verify/verify" })
  },

  goSettlements() {
    wx.navigateTo({ url: "/pages/store/settlements/settlements" })
  }
})
