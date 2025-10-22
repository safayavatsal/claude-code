/**
 * Memory Monitor Plugin Entry Point
 * Addresses Issue #9897: Claude Code using massive amounts of memory
 */

import { Logger, LogLevel } from './logger';
import { MemoryMonitor, MemoryConfig, MemoryStats } from './memoryMonitor';

export interface PluginConfig extends Partial<MemoryConfig> {
  logLevel?: string;
  autoStart?: boolean;
}

export class MemoryMonitorPlugin {
  private logger: Logger;
  private monitor: MemoryMonitor;
  private config: PluginConfig;

  constructor(config: PluginConfig = {}) {
    this.config = {
      autoStart: true,
      logLevel: 'INFO',
      ...config
    };

    // Initialize logger
    const logLevel = LogLevel[this.config.logLevel as keyof typeof LogLevel] || LogLevel.INFO;
    this.logger = new Logger('MemoryPlugin', logLevel);

    // Initialize memory monitor
    this.monitor = new MemoryMonitor(this.logger, this.config);

    // Setup event handlers
    this.setupEventHandlers();

    this.logger.info('Memory Monitor plugin initialized', { config: this.config });

    // Auto-start monitoring if enabled
    if (this.config.autoStart) {
      this.startMonitoring();
    }
  }

  /**
   * Setup event handlers for memory alerts
   */
  private setupEventHandlers(): void {
    this.monitor.on('memoryWarning', (stats: MemoryStats) => {
      console.warn(`⚠️  Memory Warning: ${stats.heapUsed}MB used (${stats.rss}MB RSS)`);
    });

    this.monitor.on('memoryCritical', (stats: MemoryStats) => {
      console.error(`🚨 Memory Critical: ${stats.heapUsed}MB used - automatic cleanup triggered`);
    });

    this.monitor.on('memoryHigh', (stats: MemoryStats) => {
      console.error(`🔥 Memory Dangerously High: ${stats.heapUsed}MB used - aggressive cleanup in progress`);
    });

    this.monitor.on('memoryEmergency', (stats: MemoryStats) => {
      console.error(`💥 EMERGENCY: Memory usage critical at ${stats.heapUsed}MB - emergency cleanup initiated`);
      console.error('   Consider restarting Claude Code if memory remains high');
    });
  }

  /**
   * Start memory monitoring
   */
  startMonitoring(): void {
    try {
      this.monitor.startMonitoring();
      console.log('🔍 Memory monitoring started - protecting against memory leaks');
    } catch (error) {
      this.logger.error('Failed to start memory monitoring', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop memory monitoring
   */
  stopMonitoring(): void {
    this.monitor.stopMonitoring();
    console.log('Memory monitoring stopped');
  }

  /**
   * Get current memory status
   */
  getMemoryStatus() {
    const status = this.monitor.getStatus();
    const current = status.current;

    return {
      ...status,
      summary: {
        heapUsedMB: current.heapUsed,
        rssMB: current.rss,
        trend: status.trend,
        status: this.getMemoryStatusLevel(current.heapUsed)
      }
    };
  }

  /**
   * Get memory status level
   */
  private getMemoryStatusLevel(heapUsedMB: number): string {
    const thresholds = this.monitor['config'].thresholds;

    if (heapUsedMB >= thresholds.emergency) return 'EMERGENCY';
    if (heapUsedMB >= thresholds.cleanup) return 'HIGH';
    if (heapUsedMB >= thresholds.critical) return 'CRITICAL';
    if (heapUsedMB >= thresholds.warning) return 'WARNING';
    return 'NORMAL';
  }

  /**
   * Track a failed request (prevents OAuth retry loops)
   */
  trackFailedRequest(requestId: string, request: any): boolean {
    return this.monitor.trackFailedRequest(requestId, request);
  }

  /**
   * Cache response with memory management
   */
  cacheResponse(key: string, response: any): void {
    this.monitor.cacheResponse(key, response);
  }

  /**
   * Get cached response
   */
  getCachedResponse(key: string): any {
    return this.monitor.getCachedResponse(key);
  }

  /**
   * Force memory cleanup
   */
  forceCleanup(level: 'light' | 'aggressive' | 'emergency' = 'light'): void {
    this.logger.info(`Forcing ${level} memory cleanup`);

    switch (level) {
      case 'light':
        this.monitor['performLightCleanup']();
        break;
      case 'aggressive':
        this.monitor['performAggressiveCleanup']();
        break;
      case 'emergency':
        this.monitor['performEmergencyCleanup']();
        break;
    }

    // Show result
    const status = this.getMemoryStatus();
    console.log(`Memory cleanup completed. Current usage: ${status.current.heapUsed}MB`);
  }

  /**
   * Get memory usage history
   */
  getMemoryHistory(limit?: number) {
    return this.monitor.getMemoryHistory(limit);
  }

  /**
   * Get diagnostics information
   */
  getDiagnostics() {
    const status = this.getMemoryStatus();
    const loggerMemory = this.logger.getMemoryUsage();

    return {
      memoryStatus: status,
      loggerMemory,
      config: this.config,
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform
    };
  }

  /**
   * Update plugin configuration
   */
  updateConfig(newConfig: Partial<PluginConfig>) {
    this.config = { ...this.config, ...newConfig };

    if (newConfig.logLevel) {
      const logLevel = LogLevel[newConfig.logLevel as keyof typeof LogLevel];
      if (logLevel !== undefined) {
        this.logger.setLogLevel(logLevel);
      }
    }

    // Update monitor config (excluding plugin-specific options)
    const { logLevel, autoStart, ...monitorConfig } = newConfig;
    if (Object.keys(monitorConfig).length > 0) {
      this.monitor.updateConfig(monitorConfig);
    }

    this.logger.info('Plugin configuration updated', { newConfig });
  }

  /**
   * Shutdown the plugin gracefully
   */
  shutdown(): void {
    this.logger.info('Shutting down Memory Monitor plugin');
    this.stopMonitoring();

    // Final cleanup
    this.forceCleanup('aggressive');

    this.logger.info('Memory Monitor plugin shutdown complete');
  }
}

// Export factory function
export function createMemoryMonitorPlugin(config?: PluginConfig): MemoryMonitorPlugin {
  return new MemoryMonitorPlugin(config);
}

// Export utilities
export { Logger, LogLevel } from './logger';
export { MemoryMonitor } from './memoryMonitor';
export type { MemoryStats, MemoryConfig, MemoryThresholds } from './memoryMonitor';

// Global instance for easy access
let globalInstance: MemoryMonitorPlugin | null = null;

export function getGlobalMemoryMonitor(): MemoryMonitorPlugin | null {
  return globalInstance;
}

export function initializeGlobalMemoryMonitor(config?: PluginConfig): MemoryMonitorPlugin {
  if (globalInstance) {
    globalInstance.shutdown();
  }
  globalInstance = new MemoryMonitorPlugin(config);
  return globalInstance;
}