const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

Page({
  data: {
    summary: {},
    records: [],
    tabs: [
      { key: "", label: "全部" },
      { key: "pending_confirm", label: "待确认" },
      { key: "unsettled", label: "可结算" },
      { key: "settled", label: "已结算" },
      { key: "chargeback", label: "退款扣回" },
      { key: "cancelled", label: "已取消" }
    ],
    activeStatus: "",
    filteredRecords: [],
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    request("/api/store/settlements").then(data => {
      const records = (data.records || []).map(item => ({
        ...item,
        amountText: `${Number(item.amount || 0) < 0 ? "-" : "+"}¥${Math.abs(Number(item.amount || 0)).toFixed(2)}`,
        isChargeback: Number(item.amount || 0) < 0 || item.type === "chargeback",
        statusText: item.statusText || (item.effectiveStatus === "pending_confirm" ? "待确认" : item.status === "settled" ? "已结算" : item.status === "cancelled" ? "已取消" : "未结算")
      }))
      this.setData({
        summary: data.summary || {},
        records
      })
      this.applyFilter()
    }).catch(error => wx.showToast({ title: error.message || "读取失败", icon: "none" }))
  },

  switchStatus(event) {
    this.setData({ activeStatus: event.currentTarget.dataset.status || "" })
    this.applyFilter()
  },

  applyFilter() {
    const status = this.data.activeStatus
    const filteredRecords = status === "chargeback"
      ? this.data.records.filter(item => item.effectiveStatus === "chargeback" || (item.status === "unsettled" && Number(item.amount || 0) < 0))
      : status ? this.data.records.filter(item => (item.effectiveStatus || item.status) === status) : this.data.records
    this.setData({ filteredRecords })
  }
})
