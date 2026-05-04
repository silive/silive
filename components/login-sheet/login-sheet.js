Component({
  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer(value) {
        if (value) {
          clearTimeout(this._closeTimer)
          this.setData({ rendered: true, leaving: false })
          return
        }
        if (this.data.rendered) this.beginClose(false)
      }
    },
    title: {
      type: String,
      value: "微信手机号授权登录"
    },
    desc: {
      type: String,
      value: "授权后同步订单、地址与会员权益"
    },
    confirmText: {
      type: String,
      value: "授权手机号并登录"
    },
    cancelText: {
      type: String,
      value: "暂不登录"
    },
    loading: {
      type: Boolean,
      value: false
    }
  },

  data: {
    rendered: false,
    leaving: false
  },

  lifetimes: {
    detached() {
      clearTimeout(this._closeTimer)
    }
  },

  methods: {
    noop() {},

    handlePhoneNumber(event) {
      this.triggerEvent("getphonenumber", event.detail || {})
    },

    handleClose() {
      this.beginClose(true)
    },

    beginClose(emitClose) {
      clearTimeout(this._closeTimer)
      this.setData({ leaving: true })
      this._closeTimer = setTimeout(() => {
        this.setData({ rendered: false, leaving: false })
        if (emitClose) this.triggerEvent("close")
      }, 180)
    }
  }
})
