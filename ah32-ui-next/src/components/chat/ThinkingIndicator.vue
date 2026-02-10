<template>
    <div class="thinking-indicator">
      <div class="thinking-avatar">
      <el-avatar :size="42" :icon="ChatDotRound" />
    </div>
    <div class="thinking-content">
      <div class="thinking-bubble">
        <div class="thinking-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <span class="thinking-text">正在思考...</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChatDotRound } from '@element-plus/icons-vue'
</script>

<style scoped lang="scss">
.thinking-indicator {
  display: flex;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-xl);
  animation: fadeInUp var(--transition-normal);
}

.thinking-avatar {
  flex-shrink: 0;

  .el-avatar {
    background: var(--secondary-gradient);
    color: #fff;
    border: 2px solid rgba(102, 126, 234, 0.2);
    box-shadow: var(--shadow-sm);
    transition: var(--transition-normal);

    &:hover {
      transform: scale(1.05);
      box-shadow: var(--shadow-md);
    }
  }
}

.thinking-content {
  flex: 1;
  max-width: 80%;
}

.thinking-bubble {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: rgba(102, 126, 234, 0.05);
  border: 1px solid rgba(102, 126, 234, 0.15);
  border-radius: var(--border-radius-xl) var(--border-radius-xl) var(--border-radius-xl) var(--border-radius-sm);
  position: relative;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: var(--shadow-sm);

  &::before {
    content: '';
    position: absolute;
    top: 16px;
    left: -8px;
    width: 0;
    height: 0;
    border-top: 8px solid transparent;
    border-bottom: 8px solid transparent;
    border-right: 8px solid rgba(102, 126, 234, 0.15);
    filter: blur(1px);
  }

  &::after {
    content: '';
    position: absolute;
    top: 14px;
    left: -6px;
    width: 0;
    height: 0;
    border-top: 10px solid transparent;
    border-bottom: 10px solid transparent;
    border-right: 10px solid rgba(102, 126, 234, 0.08);
  }
}

.thinking-dots {
  display: flex;
  gap: var(--spacing-xs);

  span {
    width: 8px;
    height: 8px;
    background: var(--primary-gradient);
    border-radius: 50%;
    animation: thinking 1.4s infinite ease-in-out;
    box-shadow: var(--shadow-xs);

    &:nth-child(1) {
      animation-delay: 0s;
    }

    &:nth-child(2) {
      animation-delay: 0.2s;
    }

    &:nth-child(3) {
      animation-delay: 0.4s;
    }
  }
}

.thinking-text {
  font-size: 15px;
  color: var(--primary-color);
  font-weight: 500;
}

@keyframes thinking {
  0%, 80%, 100% {
    transform: scale(0.8);
    opacity: 0.5;
    box-shadow: var(--shadow-xs);
  }
  40% {
    transform: scale(1.2);
    opacity: 1;
    box-shadow: var(--shadow-sm);
  }
}

// 增强动画效果
.thinking-dots span:nth-child(1) {
  animation-name: thinking;
}

.thinking-dots span:nth-child(2) {
  animation-name: thinking;
}

.thinking-dots span:nth-child(3) {
  animation-name: thinking;
}

// 脉冲动画
.thinking-bubble {
  animation: pulse 3s infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.3);
  }
  70% {
    box-shadow: 0 0 0 12px rgba(102, 126, 234, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(102, 126, 234, 0);
  }
}
</style>
