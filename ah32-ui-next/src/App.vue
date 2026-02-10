<!-- 阿蛤智能助手 - App.vue -->

<template>

  <div class="app" :class="{ dark: isDarkMode }">

    <!-- 加载过渡层 -->

    <div v-if="isLoading" class="loading-overlay">

      <div class="loading-content">

        <!-- Logo 区域 -->

        <div class="logo-container">

          <div class="logo-shape">

            <div class="hexagon-outer">

              <div class="hexagon-inner"></div>

            </div>

            <div class="logo-text">阿蛤</div>

          </div>

          <div class="tagline">智能办公 · 3秒明白 · 2秒解决</div>

        </div>



        <!-- 加载动画区域 -->

        <div class="loading-animation">

          <div class="dots-container">

            <div class="dot dot-1"></div>

            <div class="dot dot-2"></div>

            <div class="dot dot-3"></div>

          </div>

          <div class="progress-bar">

            <div class="progress-fill"></div>

          </div>

          <p class="loading-text">正在启动智能助手<span class="dots">...</span></p>

        </div>

      </div>

    </div>



    <!-- 错误显示 -->

    <div v-if="hasError" class="error-overlay">

      <div class="error-content">

        <h3>⚠️ 应用错误</h3>

        <p>{{ errorMessage }}</p>

        <div class="error-actions">

          <button @click="resetErrorState" class="retry-btn">重试</button>

          <button @click="refreshPage" class="refresh-btn">刷新页面</button>

        </div>

      </div>

    </div>



    <!-- 主内容 -->

    <div v-else class="app-container fade-in" :class="{ 'right-collapsed': rightCollapsed }">

      <!-- 左侧：对话界面 -->

      <main class="main-content">

        <ChatPanel @tool-result="handleToolResult" />

      </main>



      <!-- 右侧：文档列表和导入中心 -->

      <aside class="right-panel">

        <DocumentList />

        <!-- 文档导入中心 -->

        <div class="import-section">

          <DocumentImportCenter />

        </div>

      </aside>



      <!-- 右侧面板收起/展开：收起后对话区域变大；再次点击可恢复 -->

      <button

        class="right-panel-toggle"

        type="button"

        :title="rightCollapsed ? '展开右侧面板' : '收起右侧面板'"

        @click="toggleRightPanel"

      >

        <el-icon>

          <ArrowLeft v-if="rightCollapsed" />

          <ArrowRight v-else />

        </el-icon>

      </button>

    </div>

  </div>

</template>



<style scoped lang="scss">

/* 添加错误覆盖层样式 */

.error-overlay {

  position: absolute;

  top: 0;

  left: 0;

  width: 100%;

  height: 100%;

  display: flex;

  align-items: center;

  justify-content: center;

  z-index: 100;

  background: rgba(255, 240, 240, 0.95);

  backdrop-filter: blur(8px);

  -webkit-backdrop-filter: blur(8px);



  .error-content {

    text-align: center;

    padding: 32px;

    background: white;

    border-radius: 12px;

    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);

    max-width: 400px;



    h3 {

      margin: 0 0 16px 0;

      color: #e74c3c;

      font-size: 20px;

    }



    p {

      margin: 0 0 24px 0;

      color: #666;

      line-height: 1.5;

    }



    .error-actions {

      display: flex;

      gap: 12px;

      justify-content: center;



      button {

        padding: 8px 16px;

        border: 1px solid #ddd;

        border-radius: 6px;

        cursor: pointer;

        background: white;

        color: #333;



        &:hover {

          background: #f5f5f5;

        }



        &.retry-btn {

          background: #3498db;

          color: white;

          border-color: #3498db;



          &:hover {

            background: #2980b9;

          }

        }



        &.refresh-btn {

          background: #e74c3c;

          color: white;

          border-color: #e74c3c;



          &:hover {

            background: #c0392b;

          }

        }

      }

    }

  }

}

</style>



<script setup lang="ts">

import { ref, computed, onMounted, onUnmounted, defineAsyncComponent, watch } from 'vue'

import { ElMessage } from 'element-plus'

import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'

import '@/styles/common.css'

import { getRuntimeConfig } from '@/utils/runtime-config'



// 响应式数据

const isDarkMode = ref(false)

const isLoading = ref(true)

const hasError = ref(false)

const errorMessage = ref('')

const componentsLoaded = ref(0) // 跟踪已加载的组件数量

const totalComponents = ref(3) // 总共需要加载的组件数

const rightCollapsed = ref(false)



const RIGHT_PANEL_COLLAPSED_KEY = 'ah32_ui_right_panel_collapsed_v1'



const toggleRightPanel = () => {

  rightCollapsed.value = !rightCollapsed.value

  try {

    localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, rightCollapsed.value ? '1' : '0')

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/App.vue', e)

    // ignore

  }

}



// 使用异步组件并添加错误处理

const ChatPanel = defineAsyncComponent({

  loader: async () => {

    const module = await import('@/components/chat/ChatPanel.vue')

    componentsLoaded.value++

    return module

  },

  errorComponent: (props: { error: Error }) => {

    hasError.value = true

    isLoading.value = false // 加载失败时隐藏加载界面

    

    // 提供更详细的组件加载错误信息

    const error = props.error

    let errorMsg = '未知错误'

    if (error instanceof Error) {

      errorMsg = error.message || '组件加载失败'

    } else if (typeof error === 'string') {

      errorMsg = error

    } else if (error) {

      errorMsg = JSON.stringify(error)

    }

    

    errorMessage.value = `聊天组件加载失败: ${errorMsg}`

    return {

      template: '<div class="error-container">聊天组件加载失败，请刷新页面重试</div>'

    }

  },

  loadingComponent: () => {

    return { template: '<div>正在加载聊天组件...</div>' }

  }

})



const DocumentList = defineAsyncComponent({

  loader: async () => {

    const module = await import('@/components/document/DocumentList.vue')

    componentsLoaded.value++

    return module

  },

  errorComponent: (props: { error: Error }) => {

    hasError.value = true

    isLoading.value = false // 加载失败时隐藏加载界面

    

    // 提供更详细的组件加载错误信息

    const error = props.error

    let errorMsg = '未知错误'

    if (error instanceof Error) {

      errorMsg = error.message || '组件加载失败'

    } else if (typeof error === 'string') {

      errorMsg = error

    } else if (error) {

      errorMsg = JSON.stringify(error)

    }

    

    errorMessage.value = `文档列表组件加载失败: ${errorMsg}`

    return {

      template: '<div class="error-container">文档列表组件加载失败，请刷新页面重试</div>'

    }

  },

  loadingComponent: () => {

    return { template: '<div>正在加载文档列表...</div>' }

  }

})



const DocumentImportCenter = defineAsyncComponent({

  loader: async () => {

    const module = await import('@/components/import/DocumentImportCenter.vue')

    componentsLoaded.value++

    return module

  },

  errorComponent: (props: { error: Error }) => {

    hasError.value = true

    isLoading.value = false // 加载失败时隐藏加载界面

    

    // 提供更详细的组件加载错误信息

    const error = props.error

    let errorMsg = '未知错误'

    if (error instanceof Error) {

      errorMsg = error.message || '组件加载失败'

    } else if (typeof error === 'string') {

      errorMsg = error

    } else if (error) {

      errorMsg = JSON.stringify(error)

    }

    

    errorMessage.value = `文档导入组件加载失败: ${errorMsg}`

    return {

      template: '<div class="error-container">文档导入组件加载失败，请刷新页面重试</div>'

    }

  },

  loadingComponent: () => {

    return { template: '<div>正在加载文档导入中心...</div>' }

  }

})



// 页面加载完成

onMounted(() => {

  try {

    // 全局错误捕获由 `taskpane.html` 统一兜底（WPS 任务窗格崩溃时 devtools 往往不可用）。



    // 监听组件加载进度，当所有组件加载完成后再隐藏加载界面

    const unwatch = watch(componentsLoaded, (loadedCount) => {

      if (loadedCount >= totalComponents.value) {

        // 所有组件都已加载完成

        setTimeout(() => {

          isLoading.value = false

          unwatch() // 停止监听

        }, 300) // 稍微延迟一下，让用户看到加载完成的动画

      }

    })



    // 设置一个最大等待时间，防止组件加载失败导致一直等待

    setTimeout(() => {

      if (isLoading.value) {

        console.warn('组件加载超时，强制隐藏加载界面')

        isLoading.value = false

      }

    }, 5000) // 5秒后强制隐藏加载界面



    // Restore right panel collapsed state (persisted locally).

    try {

      rightCollapsed.value = localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === '1'

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/App.vue', e)

      rightCollapsed.value = false

    }



  } catch (error) {

    console.error('App 初始化失败:', error)

    isLoading.value = false // 确保加载状态被关闭

    hasError.value = true

    errorMessage.value = `应用初始化失败: ${error instanceof Error ? error.message : '未知错误'}`

    ElMessage.error('应用初始化失败，请刷新页面重试')

  }

})



// NOTE: global window error handlers removed (centralized in `taskpane.html`).



// 添加一个方法来重置错误状态

const resetErrorState = () => {

  hasError.value = false

  errorMessage.value = ''

  // 重新尝试加载组件

  isLoading.value = true

  componentsLoaded.value = 0

  // 重新初始化

  setTimeout(() => {

    isLoading.value = false

  }, 500)

}



// 刷新页面方法 - 优化用户体验

const refreshPage = () => {

  // 1. 隐藏错误

  hasError.value = false

  

  // 2. 显示加载动画，给用户明确反馈

  isLoading.value = true

  

  // 3. 重置组件加载计数

  componentsLoaded.value = 0

  

  // 4. 500毫秒后隐藏加载动画，提供流畅的视觉体验

  //    这个延迟是为了让用户看到加载过程，增强交互感

  //    太短会让用户觉得没有反馈，太长会让用户觉得加载慢

  //    500ms是一个平衡的选择，符合人类感知习惯

  setTimeout(() => {

    isLoading.value = false

  }, 500)

}



// 从环境变量读取后端服务器地址

const backendUrl = computed(() => {

  return getRuntimeConfig().apiBase || 'http://127.0.0.1:5123'

})



// 处理工具执行结果

const handleToolResult = (result: {

  type: 'images' | 'analysis' | 'document' | 'write' | 'clear'

  data?: any

  message?: string

}) => {

  try {

    if (result.message) {

      ElMessage.success(result.message)

    }

  } catch (error) {

    console.error('处理工具结果失败:', error)

  }

}

</script>



<style scoped lang="scss">

.app {

  width: 100%;

  height: 100vh;

  overflow: hidden;



  &.dark {

    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);

  }

}



// 加载过渡层 - 优雅专业设计（嵌入主界面）

.loading-overlay {

  position: absolute;

  top: 0;

  left: 0;

  width: 100%;

  height: 100%;

  display: flex;

  align-items: center;

  justify-content: center;

  z-index: 10;

  background: rgba(248, 250, 252, 0.95);

  backdrop-filter: blur(8px);

  -webkit-backdrop-filter: blur(8px);

}



.loading-content {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 32px;

  text-align: center;

  padding: 32px;

  background: rgba(255, 255, 255, 0.9);

  backdrop-filter: blur(10px);

  border-radius: 16px;

  border: 1px solid rgba(226, 232, 240, 0.8);

  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);

}



// Logo 区域设计

.logo-container {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 20px;

}



.logo-shape {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 16px;

}



.hexagon-outer {

  position: relative;

  width: 64px;

  height: 64px;

  animation: hexagonFloat 3s ease-in-out infinite;

}



.hexagon-inner {

  position: absolute;

  top: 50%;

  left: 50%;

  transform: translate(-50%, -50%);

  width: 48px;

  height: 48px;

  background: linear-gradient(45deg, #667eea, #764ba2);

  clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);

  animation: hexagonPulse 2s ease-in-out infinite;

}



.logo-text {

  font-size: 28px;

  font-weight: 700;

  color: #1e293b;

  margin: 0;

  letter-spacing: -0.02em;

  animation: textReveal 0.8s ease-out;

}



.tagline {

  font-size: 12px;

  color: #64748b;

  margin: 0;

  font-weight: 400;

  letter-spacing: 0.05em;

  animation: textReveal 0.8s ease-out 0.2s both;

}



// 加载动画区域

.loading-animation {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 16px;

}



.dots-container {

  display: flex;

  gap: 6px;

  align-items: center;

}



.dot {

  width: 6px;

  height: 6px;

  background: #667eea;

  border-radius: 50%;

  animation: dotBounce 1.4s ease-in-out infinite;

}



.dot-1 {

  animation-delay: 0s;

}



.dot-2 {

  animation-delay: 0.2s;

}



.dot-3 {

  animation-delay: 0.4s;

}



.progress-bar {

  width: 160px;

  height: 2px;

  background: #e2e8f0;

  border-radius: 1px;

  overflow: hidden;

}



.progress-fill {

  height: 100%;

  background: linear-gradient(90deg,

    #667eea 0%,

    #764ba2 50%,

    #667eea 100%);

  background-size: 200% 100%;

  animation: progressShimmer 2s ease-in-out infinite;

}



.loading-text {

  font-size: 14px;

  color: #475569;

  margin: 0;

  font-weight: 500;

  animation: fadeInUp 0.6s ease-out 0.4s both;

}



.dots {

  display: inline-block;

  animation: dotsTyping 1.4s steps(4, end) infinite;

}



// 主内容淡入动画

.fade-in {

  animation: fadeInScale 0.5s ease-out;

}



// 动画定义

@keyframes fadeIn {

  from {

    opacity: 0;

  }

  to {

    opacity: 1;

  }

}



@keyframes fadeInUp {

  from {

    opacity: 0;

    transform: translateY(20px);

  }

  to {

    opacity: 1;

    transform: translateY(0);

  }

}



@keyframes fadeInScale {

  from {

    opacity: 0;

    transform: scale(0.95);

  }

  to {

    opacity: 1;

    transform: scale(1);

  }

}



@keyframes bounceIn {

  0% {

    opacity: 0;

    transform: scale(0.3);

  }

  50% {

    opacity: 1;

    transform: scale(1.05);

  }

  70% {

    transform: scale(0.9);

  }

  100% {

    opacity: 1;

    transform: scale(1);

  }

}



@keyframes spin {

  0% {

    transform: rotate(0deg);

  }

  100% {

    transform: rotate(360deg);

  }

}



// 六边形浮动动画

@keyframes hexagonFloat {

  0%, 100% {

    transform: translateY(0px);

  }

  50% {

    transform: translateY(-10px);

  }

}



// 六边形脉冲动画

@keyframes hexagonPulse {

  0%, 100% {

    transform: translate(-50%, -50%) scale(1);

    opacity: 1;

  }

  50% {

    transform: translate(-50%, -50%) scale(1.1);

    opacity: 0.8;

  }

}



// 文字显示动画

@keyframes textReveal {

  0% {

    opacity: 0;

    transform: translateY(10px);

  }

  100% {

    opacity: 1;

    transform: translateY(0);

  }

}



// 点跳动动画

@keyframes dotBounce {

  0%, 80%, 100% {

    transform: scale(0);

  }

  40% {

    transform: scale(1);

  }

}



// 进度条闪烁动画

@keyframes progressShimmer {

  0% {

    background-position: -200% 0;

  }

  100% {

    background-position: 200% 0;

  }

}



// 点点点打字动画

@keyframes dotsTyping {

  0%, 20% {

    color: rgba(71, 85, 105, 0);

    text-shadow: 0.25em 0 0 rgba(71, 85, 105, 0), 0.5em 0 0 rgba(71, 85, 105, 0);

  }

  40% {

    color: rgba(71, 85, 105, 0.9);

    text-shadow: 0.25em 0 0 rgba(71, 85, 105, 0), 0.5em 0 0 rgba(71, 85, 105, 0);

  }

  60% {

    text-shadow: 0.25em 0 0 rgba(71, 85, 105, 0.9), 0.5em 0 0 rgba(71, 85, 105, 0);

  }

  80%, 100% {

    text-shadow: 0.25em 0 0 rgba(71, 85, 105, 0.9), 0.5em 0 0 rgba(71, 85, 105, 0.9);

  }

}



// 渐变流动动画

@keyframes gradientFlow {

  0%, 100% {

    background-position: 0% 50%;

  }

  50% {

    background-position: 100% 50%;

  }

}



.app-container {

  display: grid;

  grid-template-columns: 1fr minmax(320px, 420px);

  height: 100vh;

  position: relative;

  z-index: 1;

}



.app-container.right-collapsed {

  grid-template-columns: 1fr 0;



  .right-panel {

    width: 0;

    min-width: 0;

    max-width: 0;

    border-left: none;

    overflow: hidden;

    pointer-events: none;

    opacity: 0;

  }

}



@media (max-width: 768px) {

  .app-container {

    grid-template-columns: 1fr;

    grid-template-rows: 1fr auto;

  }



  .right-panel {

    max-height: 50vh;

  }



  .app-container.right-collapsed {

    grid-template-rows: 1fr 0;



    .right-panel {

      max-height: 0;

    }

  }

}



.right-panel {

  background: rgba(255, 255, 255, 0.95);

  backdrop-filter: blur(20px);

  -webkit-backdrop-filter: blur(20px);

  border-left: 1px solid rgba(226, 232, 240, 0.8);

  overflow-y: auto;

  overflow-x: hidden;

  position: relative;

  display: flex;

  flex-direction: column;

  scrollbar-gutter: stable;

  overscroll-behavior: contain;

  scrollbar-width: thin; /* Firefox */

  scrollbar-color: rgba(102, 126, 234, 0.35) transparent;



  /* Subtle top/bottom fade so the scroll feels intentional */

  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);

  mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);



  &::-webkit-scrollbar {

    width: 8px;

  }



  &::-webkit-scrollbar-track {

    background: transparent;

  }



  &::-webkit-scrollbar-thumb {

    background: linear-gradient(180deg, rgba(102, 126, 234, 0.35) 0%, rgba(118, 75, 162, 0.25) 100%);

    border-radius: 999px;

    border: 2px solid transparent;

    background-clip: content-box;

  }



  &::-webkit-scrollbar-thumb:hover {

    background: linear-gradient(180deg, rgba(102, 126, 234, 0.55) 0%, rgba(118, 75, 162, 0.4) 100%);

    border: 2px solid transparent;

    background-clip: content-box;

  }



  &::before {

    content: '';

    position: absolute;

    top: 0;

    left: 0;

    right: 0;

    bottom: 0;

    background: linear-gradient(180deg, rgba(248, 250, 252, 0.8) 0%, rgba(241, 245, 249, 0.9) 100%);

    pointer-events: none;

    z-index: -1;

  }

}



.right-panel-toggle {

  position: absolute;

  right: 6px;

  top: 50%;

  transform: translateY(-50%);

  width: 28px;

  height: 56px;

  display: flex;

  align-items: center;

  justify-content: center;

  border-radius: 999px;

  border: 1px solid rgba(148, 163, 184, 0.45);

  background: linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(248, 250, 252, 0.92) 100%);

  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.10);

  cursor: pointer;

  z-index: 5;

  transition: transform 160ms ease, box-shadow 160ms ease;



  &:hover {

    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);

    transform: translateY(-50%) scale(1.03);

  }



  &:active {

    transform: translateY(-50%) scale(0.98);

  }



  :deep(.el-icon) {

    font-size: 18px;

    color: rgba(30, 41, 59, 0.75);

  }

}



.import-section {

  margin-top: 16px;

  padding: 16px;

  border-top: 1px solid #e4e7ed;

}



.main-content {

  background: transparent;

  overflow: hidden;

  display: flex;

  flex-direction: column;

  position: relative;



  &::after {

    content: '';

    position: absolute;

    top: 0;

    right: 0;

    width: 1px;

    height: 100%;

    background: linear-gradient(180deg, transparent 0%, rgba(226, 232, 240, 0.6) 50%, transparent 100%);

    pointer-events: none;

  }



  .dark & {

    background: rgba(30, 41, 59, 0.95);

    border-left: 1px solid rgba(51, 65, 85, 0.8);



    &::before {

      background: linear-gradient(180deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.98) 100%);

    }

  }

}

</style>

