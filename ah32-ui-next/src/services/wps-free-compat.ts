/**
 * WPS免费版兼容性处理
 * 免费版不支持事件监听，完全基于手动刷新
 */
import { logger } from '@/utils/logger'
import { debounce } from '@/utils/debounce'

export class WPSFreeCompat {
  private static instance: WPSFreeCompat
  private refreshCallback: (() => Promise<void>) | null = null
  private autoRefreshTimer: NodeJS.Timeout | null = null

  private constructor() {
    // 私有构造函数，单例模式
  }

  static getInstance(): WPSFreeCompat {
    if (!WPSFreeCompat.instance) {
      WPSFreeCompat.instance = new WPSFreeCompat()
    }
    return WPSFreeCompat.instance
  }

  /**
   * 初始化免费版兼容性
   * 直接使用手动模式，不尝试事件驱动
   */
  initialize(refreshCallback: () => Promise<void>) {
    this.refreshCallback = refreshCallback

    logger.info('WPS免费版模式：使用手动刷新机制')

    // 启动定期自动刷新（替代事件监听）
    this.startAutoRefresh()

    // 监听窗口焦点变化（用户切换回WPS时刷新）
    this.setupWindowFocusListener()

    // 监听键盘快捷键（用户主动刷新）
    this.setupKeyboardListener()
  }

  /**
   * 移除定期自动刷新
   * 改为纯事件驱动：窗口焦点变化 + 键盘快捷键
   * 符合 docs/AH32_RULES.md 规范：禁止 setInterval 和定期轮询
   */
  private startAutoRefresh() {
    // 移除 setInterval 定时轮询，改为事件驱动
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer)
      this.autoRefreshTimer = null
    }
    
    logger.info('已移除定时轮询，改为纯事件驱动刷新')
  }

  /**
   * 设置窗口焦点监听
   * 当用户从其他窗口切换回WPS时，自动刷新
   */
  private setupWindowFocusListener() {
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', async () => {
        logger.debug('窗口获得焦点，执行刷新')
        if (this.refreshCallback) {
          await this.refreshCallback()
        }
      })

      window.addEventListener('blur', () => {
        logger.debug('窗口失去焦点')
      })
    }
  }

  /**
   * 设置键盘快捷键监听
   * 用户可以按F5或Ctrl+R手动刷新
   */
  private setupKeyboardListener() {
    if (typeof window !== 'undefined') {
      document.addEventListener('keydown', async (event) => {
        // F5 或 Ctrl+R 刷新
        if (event.key === 'F5' || (event.ctrlKey && event.key === 'r')) {
          event.preventDefault()
          logger.info('手动触发刷新')
          if (this.refreshCallback) {
            await this.refreshCallback()
          }
        }
      })
    }
  }

  /**
   * 手动触发刷新
   */
  async manualRefresh() {
    logger.info('手动刷新文档列表')
    if (this.refreshCallback) {
      await this.refreshCallback()
    }
  }

  /**
   * 检测WPS环境（简化版）
   * 免费版只需要检测基本环境
   */
  static detectWPSEnvironment(): boolean {
    try {
      // 检查是否有WPS对象
      const hasWPS = !!(window as any).WPS || !!(window as any).Application

      // 检查是否在WPS环境中运行
      const inWPS = hasWPS && typeof (window as any).WPS !== 'undefined'

      logger.debug('WPS环境检测:', { hasWPS, inWPS })

      return inWPS
    } catch (error) {
      logger.warn('WPS环境检测失败:', error)
      return false
    }
  }

  /**
   * 获取当前模式
   * 免费版始终返回 'manual'
   */
  static getCurrentMode(): 'manual' {
    return 'manual'
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer)
      this.autoRefreshTimer = null
    }

    this.refreshCallback = null
    logger.info('WPS免费版兼容性组件已清理')
  }
}

// 导出单例
export const wpsFreeCompat = WPSFreeCompat.getInstance()
