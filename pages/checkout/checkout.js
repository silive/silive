const { authHeader, request, uploadFileWithFallback } = require("../../utils/api")
const { ensureOpenid, getLoginState } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(decodeURIComponent(value || ""))
  } catch (error) {
    return fallback
  }
}

function buildCustomProduct(category = "图片定制") {
  return {
    id: "CUSTOM_UPLOAD",
    name: `${category}（图片定制）`,
    intro: "待客服确认报价",
    price: "0",
    priceText: "待客服确认报价",
    badge: "new",
    cover: "keyring",
    categories: [category],
    aiPreviewEnabled: "true",
    aiPreviewType: /军牌/.test(category) ? "dogtag" : /叶雕/.test(category) ? "leaf" : /木牌|激光/.test(category) ? "wood" : /宠物|摆件/.test(category) ? "stand" : /情侣/.test(category) ? "couple" : "gift"
  }
}

function getValidReferrerStoreId() {
  const app = getApp()
  if (app && typeof app.getValidReferrerStoreId === "function") return app.getValidReferrerStoreId()
  const storeId = wx.getStorageSync("referrerStoreId") || ""
  const expireAt = Number(wx.getStorageSync("referrerStoreExpireAt") || 0)
  if (!storeId) return ""
  if (!expireAt || Date.now() > expireAt) {
    wx.removeStorageSync("referrerStoreId")
    wx.removeStorageSync("referrerStoreBoundAt")
    wx.removeStorageSync("referrerStoreExpireAt")
    return ""
  }
  return storeId
}

Page({
  data: {
    product: null,
    form: {
      customerName: "",
      phone: "",
      address: "",
      customRequest: ""
    },
    phoneError: "",
    phoneTip: "仅支持中国大陆11位手机号",
    phoneTipType: "",
    aiPreview: {
      status: "",
      imageUrl: "",
      provider: "",
      message: ""
    },
    mode: "",
    category: "",
    source: "",
    uploadedImages: [],
    deliveryType: "delivery",
    pickupStores: [],
    selectedPickupStoreId: "",
    selectedPickupStore: null,
    locationStatus: "",
    userLocation: null,
    themeStyle: "",
    themeClass: "theme-skin01",
    paying: false
  },

  onLoad(options) {
    applyTheme(this)
    const mode = options.mode || ""
    const category = decodeURIComponent(options.category || "")
    let product = null
    if (options.product) product = safeJson(options.product)
    if (!product && options.productId) {
      request(`/api/products/${encodeURIComponent(options.productId)}`)
        .then(remoteProduct => this.initCheckout(remoteProduct, mode, category, options))
        .catch(() => this.initCheckout(buildCustomProduct(category), "custom", category, options))
      return
    }
    if (!product && mode === "custom") product = buildCustomProduct(category)
    if (!product) product = buildCustomProduct(category || "图片定制")
    this.initCheckout(product, mode, category, options)
  },

  onShow() {
    applyTheme(this)
  },

  initCheckout(product, mode, category, options = {}) {
    const customImage = options.customImage ? decodeURIComponent(options.customImage) : ""
    const uploadedImages = customImage ? [{ url: customImage }] : []
    const storedPhone = wx.getStorageSync("memberPhone") || ""
    const storedName = wx.getStorageSync("memberName") || ""
    this.setData({
      product,
      mode,
      category: category || (Array.isArray(product.categories) ? product.categories[0] : "") || product.name || "",
      source: options.source || "",
      customImage,
      uploadedImages,
      "form.phone": storedPhone || this.data.form.phone,
      "form.customerName": storedName || this.data.form.customerName,
      phoneTip: this.getPhoneTipState(storedPhone || this.data.form.phone).text,
      phoneTipType: this.getPhoneTipState(storedPhone || this.data.form.phone).type
    })
    if (options.customImage) {
      this.setData({
        "form.customRequest": "我已上传照片，请根据照片沟通定制方案。"
      })
    }
    if (options.autoAddress === "1") {
      setTimeout(() => this.chooseAddress({ silent: true }), 350)
    }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    let value = event.detail.value
    if (field === "phone") {
      value = value.replace(/\D/g, "").slice(0, 11)
      const tipState = this.getPhoneTipState(value)
      this.setData({
        "form.phone": value,
        phoneError: tipState.type === "error" ? tipState.text : "",
        phoneTip: tipState.text,
        phoneTipType: tipState.type
      })
      return value
    }
    this.setData({
      [`form.${field}`]: value
    })
  },

  setPhone(phone) {
    const value = String(phone || "").replace(/\D/g, "").slice(0, 11)
    const tipState = this.getPhoneTipState(value)
    this.setData({
      "form.phone": value,
      phoneError: tipState.type === "error" ? tipState.text : "",
      phoneTip: tipState.text,
      phoneTipType: tipState.type
    })
  },

  isValidPhone(phone) {
    return /^1[3-9]\d{9}$/.test(phone)
  },

  getPhoneTipState(phone) {
    if (!phone) {
      return { text: "仅支持中国大陆11位手机号", type: "" }
    }
    if (!this.isValidPhone(phone)) {
      return { text: "请输入正确的11位手机号", type: "error" }
    }
    return { text: "", type: "valid" }
  },

  validate() {
    const { customerName, phone, address, customRequest } = this.data.form
    if (!customerName) {
      wx.showToast({ title: "请填写姓名", icon: "none" })
      return false
    }
    if (!phone) {
      wx.showToast({ title: "请填写联系电话", icon: "none" })
      return false
    }
    if (!customRequest) {
      wx.showToast({ title: "请填写定制要求", icon: "none" })
      return false
    }
    if (!this.isValidPhone(phone)) {
      this.setData({
        phoneError: "请输入正确的11位手机号",
        phoneTip: "请输入正确的11位手机号",
        phoneTipType: "error"
      })
      wx.showToast({ title: "请输入正确的11位手机号", icon: "none" })
      return false
    }
    if (this.data.deliveryType === "pickup") {
      if (!this.data.selectedPickupStoreId) {
        wx.showToast({ title: "请选择自提点", icon: "none" })
        return false
      }
      return true
    }
    if (!address) {
      wx.showToast({ title: "请填写收货地址", icon: "none" })
      return false
    }
    return true
  },

  switchDelivery(event) {
    const type = event.currentTarget.dataset.type === "pickup" ? "pickup" : "delivery"
    this.setData({ deliveryType: type })
    if (type === "pickup") {
      this.loadPickupStores()
      this.requestPickupLocation()
      this.requestPickupSubscribe()
    }
  },

  requestPickupSubscribe() {
    if (!wx.requestSubscribeMessage) return
    const tmplId = wx.getStorageSync("PICKUP_TEMPLATE_ID") || ""
    if (!tmplId) return
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      complete: () => {}
    })
  },

  requestPickupLocation() {
    this.setData({ locationStatus: "locating" })
    wx.getLocation({
      type: "gcj02",
      success: res => {
        const location = { latitude: res.latitude, longitude: res.longitude }
        this.setData({ userLocation: location, locationStatus: "success" })
        this.applyPickupDistances(location)
      },
      fail: () => {
        this.setData({ locationStatus: "failed" })
        wx.showToast({ title: "暂时无法获取位置，请手动选择自提门店", icon: "none" })
      }
    })
  },

  distanceKm(from, store) {
    const lat1 = Number(from?.latitude)
    const lng1 = Number(from?.longitude)
    const lat2 = Number(store.latitude)
    const lng2 = Number(store.longitude)
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null
    const rad = Math.PI / 180
    const dLat = (lat2 - lat1) * rad
    const dLng = (lng2 - lng1) * rad
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  },

  formatDistance(km) {
    if (km == null || !Number.isFinite(Number(km))) return ""
    const num = Number(km)
    return num < 1 ? `${Math.round(num * 1000)}m` : `${num.toFixed(1)}km`
  },

  applyPickupDistances(location) {
    const stores = this.data.pickupStores.map((store, index) => {
      const distance = this.distanceKm(location, store)
      return {
        ...store,
        distance,
        distanceText: this.formatDistance(distance),
        nearest: index === 0
      }
    }).sort((a, b) => {
      if (a.distance == null && b.distance == null) return Number(a.sortOrder || 999) - Number(b.sortOrder || 999)
      if (a.distance == null) return 1
      if (b.distance == null) return -1
      return a.distance - b.distance
    }).map((store, index) => ({ ...store, nearest: index === 0 && store.distance != null }))
    this.setData({ pickupStores: stores })
  },

  loadPickupStores() {
    request("/api/pickup/stores").then(stores => {
      const list = (Array.isArray(stores) ? stores : []).map(store => ({
        ...store,
        distance: null,
        distanceText: "",
        nearest: false
      }))
      this.setData({ pickupStores: list })
      if (this.data.userLocation) this.applyPickupDistances(this.data.userLocation)
    }).catch(error => {
      wx.showToast({ title: error.message || "自提门店读取失败", icon: "none" })
    })
  },

  selectPickupStore(event) {
    const id = event.currentTarget.dataset.id
    const store = this.data.pickupStores.find(item => item.id === id)
    if (!store) return
    this.setData({
      selectedPickupStoreId: id,
      selectedPickupStore: store
    })
  },

  chooseAddress(options = {}) {
    wx.chooseAddress({
      success: address => {
        const fullAddress = [
          address.provinceName,
          address.cityName,
          address.countyName,
          address.detailInfo
        ].filter(Boolean).join(" ")
        const apply = () => {
          this.setData({
            "form.customerName": address.userName || this.data.form.customerName,
            "form.address": fullAddress || this.data.form.address
          })
          this.setPhone(address.telNumber)
        }
        if (this.data.form.customerName && address.userName && this.data.form.customerName !== address.userName) {
          wx.showModal({
            title: "覆盖姓名？",
            content: `是否使用收货地址中的姓名：${address.userName}`,
            confirmText: "使用",
            cancelText: "保留",
            success: res => {
              if (res.confirm) {
                apply()
                return
              }
              this.setData({ "form.address": fullAddress || this.data.form.address })
              this.setPhone(address.telNumber)
            }
          })
          return
        }
        apply()
      },
      fail: () => {
        if (!options.silent) wx.showToast({ title: "未选择地址，可手动填写", icon: "none" })
      }
    })
  },

  templateType() {
    const product = this.data.product || {}
    if (product.aiPreviewType) return product.aiPreviewType
    const text = `${product.name || ""} ${(product.categories || []).join(" ")} ${product.intro || ""}`
    if (/叶雕|天然叶/.test(text)) return "leaf"
    if (/宠物|摆件|3D|手办/.test(text)) return "stand"
    if (/木牌|木|激光|雕刻/.test(text)) return "wood"
    if (/军牌/.test(text)) return "dogtag"
    if (/情侣|纪念|礼物/.test(text)) return "couple"
    return "gift"
  },

  shouldGeneratePreview() {
    return this.data.mode === "custom" || String(this.data.product?.aiPreviewEnabled) === "true" || !!this.data.uploadedImages.length
  },

  generatePreview() {
    const sourceImage = this.data.uploadedImages[0]?.url || this.data.customImage || ""
    if (!sourceImage || this.data.aiPreview.status === "loading") return
    this.setData({
      aiPreview: {
        status: "loading",
        imageUrl: "",
        provider: "",
        message: "正在生成专属定制效果图..."
      }
    })
    request("/api/ai/preview", {
      method: "POST",
      timeout: 45000,
      data: {
        productId: this.data.product.id,
        productName: this.data.product.name,
        sourceImageUrl: sourceImage,
        templateType: this.templateType(),
        categories: this.data.product.categories || []
      }
    }).then(result => {
      const data = result.data || result
      this.setData({
        aiPreview: {
          status: "done",
          imageUrl: data.imageUrl,
          provider: data.provider || "",
          message: "你的专属定制预览"
        }
      })
    }).catch(() => {
      this.setData({
        aiPreview: {
          status: "error",
          imageUrl: "",
          provider: "",
          message: "预览生成失败，可稍后重试或联系客服"
        }
      })
    })
  },

  contactAdjust() {
    wx.showModal({
      title: "联系客服微调",
      content: "可把预览图发给客服，说明想调整的细节，设计师会协助确认。",
      confirmText: "知道了",
      showCancel: false
    })
  },

  validateUploadFile(file) {
    const filePath = file.tempFilePath || ""
    const fileName = filePath.split("/").pop() || ""
    const dotIndex = fileName.lastIndexOf(".")
    const ext = dotIndex > -1 ? fileName.slice(dotIndex + 1).toLowerCase() : ""
    if (ext && !["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) {
      wx.showToast({ title: "图片格式不支持，请选择jpg/png/heic", icon: "none" })
      return false
    }
    if (file.size && file.size > 10 * 1024 * 1024) {
      wx.showToast({ title: "图片超过10MB，请压缩后上传", icon: "none" })
      return false
    }
    return true
  },

  chooseImages() {
    const remain = Math.max(0, 9 - this.data.uploadedImages.length)
    if (!remain) {
      wx.showToast({ title: "最多上传9张图片", icon: "none" })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: res => {
        const files = (res.tempFiles || []).filter(file => this.validateUploadFile(file))
        if (!files.length) return
        this.uploadFiles(files, 0, [])
      }
    })
  },

  uploadFiles(files, index, urls) {
    if (index >= files.length) {
      const next = [...this.data.uploadedImages, ...urls.map(url => ({ url }))].slice(0, 9)
      this.setData({
        uploadedImages: next,
        customImage: next[0]?.url || "",
        "form.customRequest": this.data.form.customRequest || "我已上传参考图片，请根据图片沟通定制方案。"
      })
      return
    }
    const filePath = files[index].tempFilePath || files[index].path || ""
    if (!filePath) {
      wx.showToast({ title: "图片路径异常，请重新选择", icon: "none" })
      this.uploadFiles(files, index + 1, urls)
      return
    }
    wx.showLoading({ title: `上传中 ${index + 1}/${files.length}` })
    uploadFileWithFallback("/api/upload/public", {
      filePath,
      name: "file",
      header: authHeader(),
      formData: { type: "image" }
    }).then(data => {
      const imageUrl = data.url || data.data?.url || ""
      if (imageUrl) urls.push(imageUrl)
      else wx.showToast({ title: data.message || data.error || "上传失败，请重试", icon: "none" })
    }).catch(error => {
      wx.showToast({ title: error.message || "上传失败，请重试", icon: "none" })
    }).finally(() => {
        wx.hideLoading()
        this.uploadFiles(files, index + 1, urls)
    })
  },

  previewUpload(event) {
    const current = event.currentTarget.dataset.url
    wx.previewImage({
      current,
      urls: this.data.uploadedImages.map(item => item.url)
    })
  },

  removeUpload(event) {
    const index = Number(event.currentTarget.dataset.index)
    const next = this.data.uploadedImages.filter((_, itemIndex) => itemIndex !== index)
    this.setData({
      uploadedImages: next,
      customImage: next[0]?.url || "",
      aiPreview: next.length ? this.data.aiPreview : { status: "", imageUrl: "", provider: "", message: "" }
    })
  },

  submitOrder() {
    if (this.data.paying) return
    if (!getLoginState().loggedIn) {
      wx.showModal({
        title: "请先完成登录",
        content: "为保护订单信息，请先在商品详情页完成微信快捷登录后再下单。",
        confirmText: "知道了",
        showCancel: false
      })
      return
    }
    if (!this.validate()) return
    this.setData({ paying: true })
    wx.setStorageSync("memberPhone", this.data.form.phone)
    wx.setStorageSync("memberName", this.data.form.customerName)
    const referrerStoreId = getValidReferrerStoreId()
    ensureOpenid().then(openid => request("/api/orders", {
        method: "POST",
        data: {
          productId: this.data.product.id,
          openid,
          userSession: wx.getStorageSync("userSession") || "",
          userId: wx.getStorageSync("localUserId") || "",
          userToken: wx.getStorageSync("userToken") || wx.getStorageSync("localUserId") || "",
          inviterCode: wx.getStorageSync("boundInviterCode") || wx.getStorageSync("inviterCode") || "",
          newcomerBenefitText: wx.getStorageSync("newcomerBenefitText") || "",
          remark: this.data.uploadedImages.length ? `上传图片：${this.data.uploadedImages.map(item => item.url).join("，")}` : "",
          originalImageUrl: this.data.uploadedImages[0]?.url || "",
          originalImageUrls: this.data.uploadedImages.map(item => item.url),
          aiPreviewUrl: "",
          finalDesignUrl: "",
          category: this.data.category,
          isCustomOrder: this.data.mode === "custom" ? "true" : "false",
          source: this.data.source || "",
          deliveryType: this.data.deliveryType,
          pickupStoreId: this.data.selectedPickupStoreId,
          userLatitude: this.data.userLocation?.latitude || "",
          userLongitude: this.data.userLocation?.longitude || "",
          pickupDistance: this.data.selectedPickupStore?.distance == null ? "" : Number(this.data.selectedPickupStore.distance).toFixed(2),
          referrerStoreId,
          ...this.data.form
        }
      })).then(order => {
      const orderId = order.id || order.orderId || order.data?.orderId || ""
      console.log("[pay] create order result", {
        ok: !!orderId,
        orderId,
        message: order.message || ""
      })
      if (!orderId) throw new Error(order.message || "订单创建失败")
      return this.pay(orderId)
    }).catch(error => {
      wx.showToast({ title: error.message || "下单失败", icon: "none" })
    }).finally(() => {
      this.setData({ paying: false })
    })
  },

  pay(orderId) {
    return ensureOpenid().then(openid => {
      console.log("[pay] request pay params", {
        orderId,
        url: "/api/pay/wechat"
      })
      return request("/api/pay/wechat", {
        method: "POST",
        data: { orderId, openid, userSession: wx.getStorageSync("userSession") || "" }
      })
    }).then(payData => {
      if (payData.mock) return this.mockPaySuccess(orderId)
      console.log("[pay] pay params result", {
        ok: !!(payData.timeStamp && payData.nonceStr && payData.package && payData.paySign),
        hasTimeStamp: !!payData.timeStamp,
        hasNonceStr: !!payData.nonceStr,
        hasPackage: !!payData.package,
        hasPaySign: !!payData.paySign,
        message: payData.message || ""
      })
      if (!payData.timeStamp || !payData.nonceStr || !payData.package || !payData.paySign) {
        throw new Error(payData.message || "微信支付暂未完成配置，请联系商家确认订单")
      }
      return new Promise((resolve, reject) => {
        wx.requestPayment({
          ...payData,
          success: res => {
            console.log("[pay] wx.requestPayment result", { errMsg: res.errMsg })
            resolve(res)
          },
          fail: err => {
            console.log("[pay] wx.requestPayment result", { errMsg: err.errMsg })
            reject(new Error(err.errMsg || "支付失败"))
          },
          complete: res => {
            console.log("[pay] wx.requestPayment complete", { errMsg: res.errMsg })
          }
        })
      })
    }).then(() => {
      wx.showToast({ title: "支付成功", icon: "success" })
      setTimeout(() => wx.switchTab({ url: "/pages/orders/orders" }), 800)
    })
  },

  mockPaySuccess(orderId) {
    return request("/api/pay/mock-success", {
      method: "POST",
      data: { orderId }
    })
  }
})
