const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

Page({
  data: {
    summary: {},
    records: [],
    tabs: [
      { key: "", label: "全部" },
      { key: "unsettled", label: "未结算" },
      { key: "settled", label: "已结算" },
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
        statusText: item.statusText || (item.status === "settled" ? "已结算" : item.status === "cancelled" ? "已取消" : "未结算")
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
    const filteredRecords = status ? this.data.records.filter(item => item.status === status) : this.data.records
    this.setData({ filteredRecords })
  }
})
