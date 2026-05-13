const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

function normalizePickupCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
}

function pickupCodeFromScan(value) {
  const text = String(value || "").trim()
  if (!text) return ""
  if (/^[A-Za-z0-9]{6}$/.test(text)) return normalizePickupCode(text)
  const queryMatch = text.match(/[?&](?:pickupCode|pickup_code|code)=([A-Za-z0-9]{6})/)
  if (queryMatch) return normalizePickupCode(queryMatch[1])
  const looseMatch = text.match(/[A-Za-z0-9]{6}/)
  return looseMatch ? normalizePickupCode(looseMatch[0]) : ""
}

Page({
  data: {
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
    const pickupCode = normalizePickupCode(event.detail.value)
    this.setData({ pickupCode })
    if (pickupCode.length === 6 && !this.data.verifying) {
      this.verifyByCode(pickupCode)
    }
  },

  scanPickupCode() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ["qrCode", "barCode"],
      success: result => {
        const pickupCode = pickupCodeFromScan(result.result)
        if (!pickupCode) {
          wx.showToast({ title: "未识别到取货码", icon: "none" })
          return
        }
        this.setData({ pickupCode })
        this.verifyByCode(pickupCode)
      },
      fail: error => {
        const msg = String(error.errMsg || "")
        wx.showToast({ title: msg.includes("cancel") ? "已取消扫码" : "扫码失败，请手动输入", icon: "none" })
      }
    })
  },

  verifyManual() {
    const pickupCode = normalizePickupCode(this.data.pickupCode)
    if (pickupCode.length !== 6) {
      wx.showToast({ title: "请输入6位取货码", icon: "none" })
      return
    }
    this.verifyByCode(pickupCode)
  },

  verifyByCode(pickupCode) {
    if (this.data.verifying) return
    this.setData({ verifying: true, result: null })
    request("/api/store/verify", {
      method: "POST",
      data: { pickupCode }
    }).then(data => {
      this.setData({ result: data })
      if (data.alreadyVerified) {
        wx.showModal({
          title: "订单已核销",
          content: `核销时间：${data.verifiedAt || "-"}\n核销门店：${data.verifiedStore || "-"}`,
          showCancel: false
        })
        return
      }
      wx.vibrateShort({ type: "medium" })
      wx.showToast({ title: "核销成功", icon: "success" })
    }).catch(error => {
      wx.showModal({ title: "核销失败", content: error.message || "请检查取货码", showCancel: false })
    }).finally(() => {
      this.setData({ verifying: false })
    })
  }
})
