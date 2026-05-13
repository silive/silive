Component({
  properties: {
    active: {
      type: String,
      value: "home"
    }
  },

  methods: {
    goHome() {
      wx.switchTab({ url: "/pages/index/index" })
    },

    goOrders() {
      wx.switchTab({ url: "/pages/orders/orders" })
    },

    goProfile() {
      wx.switchTab({ url: "/pages/profile/profile" })
    }
  }
})
