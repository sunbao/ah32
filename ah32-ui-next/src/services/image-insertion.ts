/**
 * 图片检索与插入服务
 */
import { knowledgeApi } from './api'
import { wpsBridge } from './wps-bridge'
import type { ImageResult } from './types'

export class ImageInsertionService {
  /**
   * 根据关键词检索相关图片
   */
  async searchRelevantImages(keyword: string, limit: number = 5): Promise<ImageResult[]> {
    try {
      // 从知识库中搜索图片
      const response = await knowledgeApi.searchImages(keyword, 'image', limit)

      const images = (response as any).images || response.data?.images || []

      return images.map((img: any) => ({
        id: img.id,
        url: img.url || img.path,
        path: img.path,
        relevance: img.relevance || 0,
        metadata: img.metadata || {}
      }))
    } catch (error) {
      console.error('检索图片失败:', error)
      return []
    }
  }

  /**
   * 插入最相关的图片
   */
  async insertMostRelevantImage(keyword: string): Promise<boolean> {
    try {
      const images = await this.searchRelevantImages(keyword, 1)

      if (images.length === 0) {
        return false
      }

      const image = images[0]
      if (!image) {
        return false
      }

      wpsBridge.insertImage(image.path, 300, 200) // 默认尺寸 300x200
      return true
    } catch (error) {
      console.error('插入图片失败:', error)
      return false
    }
  }

  /**
   * 插入多张相关图片
   */
  async insertMultipleImages(keyword: string, count: number = 3): Promise<number> {
    try {
      const images = await this.searchRelevantImages(keyword, count)

      if (images.length === 0) {
        return 0
      }

      let insertedCount = 0
      for (const image of images) {
        try {
          wpsBridge.insertImage(image.path, 300, 200)
          insertedCount++

          // 图片之间添加间隔
          if (insertedCount < images.length) {
            wpsBridge.insertLineBreak(1)
          }
        } catch (error) {
          console.error(`插入图片失败: ${image.path}`, error)
        }
      }

      return insertedCount
    } catch (error) {
      console.error('批量插入图片失败:', error)
      return 0
    }
  }

  /**
   * 智能插入：在文本后自动插入相关图片
   */
  async smartInsertImageAfterText(text: string): Promise<void> {
    try {
      // 提取关键词
      const keywords = this.extractKeywords(text)

      if (keywords.length === 0) {
        return
      }

      // 为每个关键词尝试插入图片
      for (let i = 0; i < Math.min(keywords.length, 2); i++) { // 最多插入2个关键词的图片
        const keyword = keywords[i]
        if (!keyword) continue

        // 添加段落间隔
        if (i > 0) {
          wpsBridge.insertLineBreak(2)
        }

        // 插入图片
        await this.insertMostRelevantImage(keyword)
      }

      // 添加最后的段落间隔
      wpsBridge.insertLineBreak(1)
    } catch (error) {
      console.error('智能插入图片失败:', error)
      throw error
    }
  }

  /**
   * 根据图片类型智能匹配
   */
  async insertByImageType(
    keyword: string,
    imageType: 'diagram' | 'chart' | 'photo' | 'illustration' | 'all' = 'all'
  ): Promise<number> {
    try {
      // 根据类型调整搜索关键词
      const typeKeywords = {
        diagram: `${keyword} 架构图 流程图`,
        chart: `${keyword} 图表 统计图`,
        photo: `${keyword} 实拍 实物`,
        illustration: `${keyword} 插图 示意图`,
        all: keyword
      }

      const searchKeyword = typeKeywords[imageType]
      return await this.insertMultipleImages(searchKeyword, 2)
    } catch (error) {
      console.error('按类型插入图片失败:', error)
      return 0
    }
  }

  /**
   * 从文本中提取关键词
   */
  private extractKeywords(text: string): string[] {
    const keywords: string[] = []

    // 查找技术相关词汇
    const techTerms = [
      '架构图', '流程图', '示意图', '图表', '设计图',
      '系统图', '网络图', '拓扑图', '模块图', '组件图',
      '时序图', '类图', '用例图', '状态图', '活动图'
    ]

    for (const term of techTerms) {
      if (text.includes(term)) {
        keywords.push(term)
      }
    }

    // 查找业务相关词汇
    const businessTerms = [
      '业务流程', '业务逻辑', '业务规则', '业务场景',
      '产品功能', '功能模块', '核心功能', '特色功能',
      '技术方案', '实施方案', '部署方案', '解决方案'
    ]

    for (const term of businessTerms) {
      if (text.includes(term)) {
        keywords.push(term)
      }
    }

    // 查找常见名词（简单实现）
    const nouns = text.match(/\b[\u4e00-\u9fa5]{2,6}\b/g) || []

    // 过滤常见词汇
    const filtered = nouns.filter(noun => {
      const commonWords = ['的', '了', '在', '是', '和', '与', '或', '但', '如果', '那么']
      return !commonWords.includes(noun) && noun.length >= 2
    })

    // 添加前3个名词
    keywords.push(...filtered.slice(0, 3))

    // 去重
    return [...new Set(keywords)]
  }

  /**
   * 获取图片推荐
   */
  async getImageRecommendations(text: string, limit: number = 5): Promise<ImageResult[]> {
    try {
      const keywords = this.extractKeywords(text) || []
      const allImages: ImageResult[] = []

      for (const keyword of keywords.slice(0, 3)) {
        if (!keyword) continue
        const images = await this.searchRelevantImages(keyword, Math.ceil(limit / keywords.length))
        allImages.push(...images)
      }

      // 按相关性排序并去重
      const uniqueImages = allImages.reduce((acc: ImageResult[], current) => {
        const exists = acc.find(img => img.id === current.id)
        if (!exists) {
          acc.push(current)
        }
        return acc
      }, [])

      return uniqueImages
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit)
    } catch (error) {
      console.error('获取图片推荐失败:', error)
      return []
    }
  }

  /**
   * 批量处理图片插入
   */
  async batchInsert(
    imageRequests: Array<{
      keyword: string
      position?: 'after' | 'before'
      count?: number
    }>
  ): Promise<number> {
    try {
      let totalInserted = 0

      for (const request of imageRequests) {
        const { keyword, position = 'after', count = 1 } = request

        // 移动到适当位置（这里简化处理，实际需要根据position参数调整）
        if (position === 'before') {
          wpsBridge.insertLineBreak(1)
        }

        // 插入图片
        const inserted = await this.insertMultipleImages(keyword, count)
        totalInserted += inserted

        // 添加间隔
        wpsBridge.insertLineBreak(1)
      }

      return totalInserted
    } catch (error) {
      console.error('批量插入图片失败:', error)
      return 0
    }
  }
}

// 创建全局实例
export const imageService = new ImageInsertionService()

// 导出便捷方法
export const ImageHelper = {
  /**
   * 快速插入单张图片
   */
  async quickInsert(keyword: string): Promise<boolean> {
    return imageService.insertMostRelevantImage(keyword)
  },

  /**
   * 快速插入多张图片
   */
  async quickInsertMultiple(keyword: string, count: number = 3): Promise<number> {
    return imageService.insertMultipleImages(keyword, count)
  },

  /**
   * 智能插入图片
   */
  async smartInsert(text: string): Promise<void> {
    return imageService.smartInsertImageAfterText(text)
  }
}
