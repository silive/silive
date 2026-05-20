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
      value: "手机号快捷登录"
    },
    desc: {
      type: String,
      value: "我们将申请获取并验证你的手机号，用于订单确认、配送联系、售后服务及账号身份识别。未经你同意，不会用于其他无关用途。"
    },
    confirmText: {
      type: String,
      value: "手机号快捷登录"
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
      const detail = event.detail || {}
      console.log("[login] getPhoneNumber detail", {
        errMsg: detail.errMsg,
        errno: detail.errno,
        hasPhoneCode: !!detail.code
      })
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
