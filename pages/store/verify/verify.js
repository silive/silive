const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

Page({
  data: {
    orderId: "",
    pickupCode: "",
    result: null,
    verifying: false,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value.trim() })
  },

  verify() {
    if (!this.data.orderId || !this.data.pickupCode) {
      wx.showToast({ title: "请输入订单号和取货码", icon: "none" })
      return
    }
    this.setData({ verifying: true, result: null })
    request(`/api/store/orders/${encodeURIComponent(this.data.orderId)}/verify-pickup`, {
      method: "POST",
      data: { pickupCode: this.data.pickupCode }
    }).then(data => {
      this.setData({ result: data })
      wx.showToast({ title: "核销成功", icon: "success" })
    }).catch(error => {
      wx.showModal({ title: "核销失败", content: error.message || "请检查订单号和取货码", showCancel: false })
    }).finally(() => {
      this.setData({ verifying: false })
    })
  }
})
