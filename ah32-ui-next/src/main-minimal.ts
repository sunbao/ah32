// 最简化的 Vue 应用，用于诊断
import { createApp } from 'vue'

// console.log('main-minimal.ts 正在执行...')

// 设置全局对象
if (typeof window !== 'undefined') {
  window.Vue = createApp
  // console.log('✓ Vue 已设置到全局对象')
}

// 创建简单的应用
const App = {
  template: '<div style="padding: 20px; color: green;">✓ Vue 加载成功！</div>'
}

const app = createApp(App)
app.mount('#app')

// console.log('✓ Vue 应用已挂载')
