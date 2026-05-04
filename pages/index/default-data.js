module.exports = {
  banners: [
    {
      tag: "PET MEMORY",
      title: "把想念做成桌面小治愈",
      desc: "宠物照片定制摆件，放在每天都能看见的地方",
      theme: "print",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/banner-studio.svg",
      targetType: "primary",
      targetValue: "3D打印"
    },
    {
      tag: "LOVE GIFT",
      title: "纪念日礼物要有一点特别",
      desc: "名字、日期、手写字都可以雕刻，送TA更有心意",
      theme: "laser",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/banner-laser.svg",
      targetType: "primary",
      targetValue: "激光定制"
    },
    {
      tag: "BEST FRIEND",
      title: "给闺蜜的生日礼物灵感",
      desc: "真实叶片镂空雕刻，轻盈又高级的纪念感",
      theme: "studio",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/banner-leaf.svg",
      targetType: "secondary",
      targetValue: "激光定制/叶雕纪念"
    }
  ],
  categories: [
    { icon: "◆", name: "激光定制", desc: "亚克力夜灯 / 木牌雕刻 / 叶雕纪念" },
    { icon: "✦", name: "3D打印", desc: "零件加工 / 工业打样 / 手办打印" },
    { icon: "＋", name: "潮玩手办", desc: "解压玩具 / 热门手办 / 创意摆件" }
  ],
  homeEntries: [
    { name: "激光定制", desc: "照片刻成心意礼物", icon: "光", imageUrl: "", targetType: "primary", targetValue: "激光定制", visible: "true", sort: "1" },
    { name: "3D打印", desc: "模型文件直接生产", icon: "模", imageUrl: "", targetType: "primary", targetValue: "3D打印", visible: "true", sort: "2" },
    { name: "潮玩手办", desc: "高颜值现货小物", icon: "潮", imageUrl: "", targetType: "primary", targetValue: "潮玩手办", visible: "true", sort: "3" },
    { name: "联系客服", desc: "1对1确认灵感方案", icon: "聊", imageUrl: "", targetType: "service", targetValue: "", visible: "true", sort: "4" }
  ],
  trustTags: [
    { icon: "人", text: "已服务客户 1286+" },
    { icon: "赞", text: "好评率 99%" },
    { icon: "快", text: "急速生产" },
    { icon: "审", text: "一对一设计确认" }
  ],
  products: [
    {
      id: "P_LEAF_001",
      name: "天然叶雕纪念礼",
      intro: "真叶镂空雕刻 / 赠礼盒 / 下单先确认设计",
      price: "168",
      badge: "best",
      cover: "wood",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/product-leaf.svg",
      categories: ["激光定制", "激光定制/叶雕纪念", "叶雕定制"]
    },
    {
      id: "P_PET_001",
      name: "宠物照片3D摆件",
      intro: "照片建模 / 桌面治愈 / 适合养宠女生",
      price: "129",
      badge: "hot",
      cover: "pet",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/product-pet.svg",
      categories: ["3D打印", "3D打印/手办打印"]
    },
    {
      id: "P_WOOD_001",
      name: "纪念日激光雕刻牌",
      intro: "胡桃木质感 / 可刻名字日期 / 情侣礼物",
      price: "89",
      badge: "hot",
      cover: "wood",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/product-wood.svg",
      categories: ["激光定制", "激光定制/木牌雕刻", "激光雕刻"]
    },
    {
      id: "P_KEYRING_001",
      name: "星光名字钥匙扣",
      intro: "镜面亚克力 / 可刻字 / 闺蜜小礼物",
      price: "39",
      badge: "new",
      cover: "keyring",
      imageUrl: "https://api.feichangjiandan.xyz/uploads/product-keyring.svg",
      categories: ["潮玩手办", "潮玩手办/创意摆件", "名字礼物", "激光雕刻"]
    }
  ],
  reviews: [
    { avatar: "林", name: "林女士", product: "天然叶雕纪念礼", text: "设计稿确认得很细，礼盒质感比预期高级，送朋友很有纪念感。" },
    { avatar: "M", name: "Mia", product: "星光名字钥匙扣", text: "小小一个但很精致，刻字清楚，作为闺蜜礼物刚刚好。" },
    { avatar: "陈", name: "陈女士", product: "宠物照片3D摆件", text: "照片还原度不错，客服会先确认细节，收到实物很治愈。" }
  ],
  promoText: "人气礼物灵感 · 下单前一对一确认设计",
  sectionTitle: "热门商品",
  sectionSubtitle: "生日、纪念日、闺蜜礼物和宠物纪念都适合",
  contact: {
    phone: "13800000000",
    wechat: "VerySimpleCustom",
    workWechatUrl: ""
  }
}
