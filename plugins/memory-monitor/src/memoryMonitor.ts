/**
 * Memory Monitoring and Management Module
 * Fixes Issue #9897: Claude Code using massive amounts of memory (up to 20GB)
 *
 * Key improvements:
 * - Real-time memory usage monitoring
 * - Automatic cleanup of failed requests and cached objects
 * - Memory leak detection and prevention
 * - OAuth retry loop prevention
 * - Performance optimization
 */

import { Logger } from './logger';
import { EventEmitter } from 'events';

export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  timestamp: number;
}

export interface MemoryThresholds {
  warning: number;    // MB
  critical: number;   // MB
  cleanup: number;    // MB
  emergency: number;  // MB
}

export interface MemoryConfig {
  monitorInterval: number;  // ms
  thresholds: MemoryThresholds;
  enableAutoCleanup: boolean;
  maxRetryHistory: number;
  enableGC: boolean;
}

export class MemoryMonitor extends EventEmitter {
  private logger: Logger;
  private config: MemoryConfig;
  private monitorTimer?: NodeJS.Timeout;
  private memoryHistory: MemoryStats[] = [];
  private failedRequests = new Map<string, any>();
  private responseCache = new Map<string, any>();
  private retryCounters = new Map<string, number>();
  private isMonitoring = false;

  // Default configuration based on Issue #9897 analysis
  private static readonly DEFAULT_CONFIG: MemoryConfig = {
    monitorInterval: 30000, // 30 seconds
    thresholds: {
      warning: 1000,   // 1GB
      critical: 2000,  // 2GB
      cleanup: 5000,   // 5GB
      emergency: 10000 // 10GB - way before the reported 20GB
    },
    enableAutoCleanup: true,
    maxRetryHistory: 100,
    enableGC: true
  };

  constructor(logger: Logger, config: Partial<MemoryConfig> = {}) {
    super();
    this.logger = logger;
    this.config = { ...MemoryMonitor.DEFAULT_CONFIG, ...config };

    this.logger.info('Memory Monitor initialized', { config: this.config });
  }

  /**
   * Start memory monitoring
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      this.logger.warn('Memory monitoring already active');
      return;
    }

    this.isMonitoring = true;
    this.monitorTimer = setInterval(() => {
      this.checkMemoryUsage();
    }, this.config.monitorInterval);

    this.logger.info('Memory monitoring started', {
      interval: this.config.monitorInterval,
      thresholds: this.config.thresholds
    });

    // Initial check
    this.checkMemoryUsage();
  }

  /**
   * Stop memory monitoring
   */
  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    this.isMonitoring = false;
    this.logger.info('Memory monitoring stopped');
  }

  /**
   * Get current memory usage statistics
   */
  getCurrentMemoryStats(): MemoryStats {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
      arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024), // MB
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      timestamp: Date.now()
    };
  }

  /**
   * Check memory usage and trigger actions if thresholds are exceeded
   */
  private checkMemoryUsage(): void {
    const stats = this.getCurrentMemoryStats();
    this.memoryHistory.push(stats);

    // Keep only last 100 measurements
    if (this.memoryHistory.length > 100) {
      this.memoryHistory.shift();
    }

    const { heapUsed } = stats;
    const thresholds = this.config.thresholds;

    this.logger.debug('Memory check', stats);

    if (heapUsed >= thresholds.emergency) {
      this.handleEmergencyMemory(stats);
    } else if (heapUsed >= thresholds.cleanup) {
      this.handleHighMemory(stats);
    } else if (heapUsed >= thresholds.critical) {
      this.handleCriticalMemory(stats);
    } else if (heapUsed >= thresholds.warning) {
      this.handleWarningMemory(stats);
    }

    this.emit('memoryCheck', stats);
  }

  /**
   * Handle warning level memory usage
   */
  private handleWarningMemory(stats: MemoryStats): void {
    this.logger.warn('Memory usage at warning level', stats);
    this.emit('memoryWarning', stats);

    // Start cleaning old history
    this.cleanupOldHistory();
  }

  /**
   * Handle critical level memory usage
   */
  private handleCriticalMemory(stats: MemoryStats): void {
    this.logger.error('Memory usage at critical level', stats);
    this.emit('memoryCritical', stats);

    if (this.config.enableAutoCleanup) {
      this.performLightCleanup();
    }
  }

  /**
   * Handle high memory usage (5GB+)
   */
  private handleHighMemory(stats: MemoryStats): void {
    this.logger.error('Memory usage dangerously high', stats);
    this.emit('memoryHigh', stats);

    if (this.config.enableAutoCleanup) {
      this.performAggressiveCleanup();
    }
  }

  /**
   * Handle emergency memory usage (10GB+)
   */
  private handleEmergencyMemory(stats: MemoryStats): void {
    this.logger.error('EMERGENCY: Memory usage critical - performing emergency cleanup', stats);
    this.emit('memoryEmergency', stats);

    // Emergency cleanup regardless of configuration
    this.performEmergencyCleanup();
  }

  /**
   * Light cleanup - remove old entries
   */
  private performLightCleanup(): void {
    this.logger.info('Performing light memory cleanup');

    // Clear old failed requests (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [key, request] of this.failedRequests.entries()) {
      if (request.timestamp < fiveMinutesAgo) {
        this.failedRequests.delete(key);
      }
    }

    // Limit response cache size
    if (this.responseCache.size > 100) {
      const entries = Array.from(this.responseCache.entries());
      const toDelete = entries.slice(0, entries.length - 50);
      toDelete.forEach(([key]) => this.responseCache.delete(key));
    }

    this.logger.info('Light cleanup completed', {
      failedRequestsCount: this.failedRequests.size,
      responseCacheCount: this.responseCache.size
    });
  }

  /**
   * Aggressive cleanup - clear most cached data
   */
  private performAggressiveCleanup(): void {
    this.logger.warn('Performing aggressive memory cleanup');

    // Clear all failed requests
    this.failedRequests.clear();

    // Keep only recent response cache entries
    if (this.responseCache.size > 20) {
      const entries = Array.from(this.responseCache.entries());
      const toKeep = entries.slice(-20);
      this.responseCache.clear();
      toKeep.forEach(([key, value]) => this.responseCache.set(key, value));
    }

    // Reset retry counters
    this.retryCounters.clear();

    // Trigger garbage collection if enabled
    if (this.config.enableGC && global.gc) {
      global.gc();
      this.logger.info('Forced garbage collection');
    }

    this.logger.warn('Aggressive cleanup completed');
  }

  /**
   * Emergency cleanup - clear everything possible
   */
  private performEmergencyCleanup(): void {
    this.logger.error('Performing EMERGENCY memory cleanup');

    // Clear everything
    this.failedRequests.clear();
    this.responseCache.clear();
    this.retryCounters.clear();

    // Clear old memory history
    this.memoryHistory = this.memoryHistory.slice(-10);

    // Force multiple garbage collections
    if (global.gc) {
      for (let i = 0; i < 3; i++) {
        global.gc();
      }
      this.logger.error('Forced multiple garbage collections');
    }

    this.logger.error('EMERGENCY cleanup completed - system may need restart if memory remains high');
  }

  /**
   * Clean up old history entries
   */
  private cleanupOldHistory(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.memoryHistory = this.memoryHistory.filter(stat => stat.timestamp > oneHourAgo);
  }

  /**
   * Track failed request to prevent memory leaks from retry loops
   */
  trackFailedRequest(requestId: string, request: any): void {
    const retryCount = (this.retryCounters.get(requestId) || 0) + 1;
    this.retryCounters.set(requestId, retryCount);

    // Prevent infinite retry loops (Issue #9897 mentions OAuth retry loops)
    const MAX_RETRIES = 5;
    if (retryCount > MAX_RETRIES) {
      this.logger.error('Request exceeded maximum retries - stopping to prevent memory leak', {
        requestId,
        retryCount
      });
      this.retryCounters.delete(requestId);
      return false; // Signal to stop retrying
    }

    this.failedRequests.set(requestId, {
      ...request,
      timestamp: Date.now(),
      retryCount
    });

    return true; // Can continue retrying
  }

  /**
   * Cache response with size limits
   */
  cacheResponse(key: string, response: any): void {
    // Prevent cache from growing too large
    if (this.responseCache.size >= 200) {
      // Remove oldest entries
      const oldestKeys = Array.from(this.responseCache.keys()).slice(0, 50);
      oldestKeys.forEach(k => this.responseCache.delete(k));
    }

    this.responseCache.set(key, {
      data: response,
      timestamp: Date.now()
    });
  }

  /**
   * Get cached response
   */
  getCachedResponse(key: string): any {
    const cached = this.responseCache.get(key);
    if (!cached) return null;

    // Check if cache entry is too old (1 hour)
    const isExpired = Date.now() - cached.timestamp > 60 * 60 * 1000;
    if (isExpired) {
      this.responseCache.delete(key);
      return null;
    }

    return cached.data;
  }

  /**
   * Get memory usage history
   */
  getMemoryHistory(limit: number = 50): MemoryStats[] {
    return this.memoryHistory.slice(-limit);
  }

  /**
   * Get current status
   */
  getStatus() {
    const current = this.getCurrentMemoryStats();
    const trend = this.calculateMemoryTrend();

    return {
      current,
      trend,
      isMonitoring: this.isMonitoring,
      cacheStats: {
        failedRequests: this.failedRequests.size,
        responseCache: this.responseCache.size,
        retryCounters: this.retryCounters.size
      },
      thresholds: this.config.thresholds
    };
  }

  /**
   * Calculate memory usage trend
   */
  private calculateMemoryTrend(): 'increasing' | 'decreasing' | 'stable' {
    if (this.memoryHistory.length < 5) return 'stable';

    const recent = this.memoryHistory.slice(-5);
    const first = recent[0].heapUsed;
    const last = recent[recent.length - 1].heapUsed;
    const diff = last - first;

    if (Math.abs(diff) < 50) return 'stable'; // Less than 50MB change
    return diff > 0 ? 'increasing' : 'decreasing';
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Memory monitor configuration updated', { newConfig });

    // Restart monitoring if interval changed
    if (newConfig.monitorInterval && this.isMonitoring) {
      this.stopMonitoring();
      this.startMonitoring();
    }
  }
}