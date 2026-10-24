/**
 * 猫咪值班室 · 开源标准预设配置 (公开演示 Demo 矩阵)
 * 仅包含公开通用示例，无任何私有 IP 或个人隐私域名
 */
export const DEFAULT_CONFIG = {
  profile: {
    title: "猫咪值班室",
    subtitle: "一页直达，猫在值班",
    avatar: "/avatar.jpg",
    wanDomain: "example.com"
  },
  settings: {
    theme: "light",
    activeHostMode: "wan",
    autoPing: true,
    pingIntervalSeconds: 20,
    openInNewTab: true
  },
  categories: [
    {
      id: "services",
      name: "服务列表",
      icon: "⚡"
    }
  ],
  projects: [
    {
      id: "p-github",
      categoryId: "services",
      title: "GitHub 代码中枢",
      customWanUrl: "https://github.com",
      pingEnabled: true
    },
    {
      id: "p-vercel",
      categoryId: "services",
      title: "Vercel 部署平台",
      customWanUrl: "https://vercel.com",
      pingEnabled: true
    },
    {
      id: "p-cloudflare",
      categoryId: "services",
      title: "Cloudflare 边缘网络",
      customWanUrl: "https://cloudflare.com",
      pingEnabled: true
    }
  ]
};
