/**
 * Test Suite for Memory Monitor Plugin
 * Tests the critical memory leak scenarios identified in Issue #9897
 */

import { MemoryMonitor, MemoryConfig } from '../src/memoryMonitor';
import { Logger, LogLevel } from '../src/logger';
import { createMemoryMonitorPlugin } from '../src/index';

describe('MemoryMonitor', () => {
  let monitor: MemoryMonitor;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = new Logger('TestMonitor', LogLevel.ERROR); // Reduce test noise
    monitor = new MemoryMonitor(mockLogger, {
      monitorInterval: 100, // Fast interval for testing
      thresholds: {
        warning: 10,   // Very low for testing
        critical: 20,
        cleanup: 30,
        emergency: 50
      }
    });
  });

  afterEach(() => {
    monitor.stopMonitoring();
  });

  describe('Memory Monitoring', () => {
    it('should start and stop monitoring', () => {
      expect(monitor['isMonitoring']).toBe(false);

      monitor.startMonitoring();
      expect(monitor['isMonitoring']).toBe(true);

      monitor.stopMonitoring();
      expect(monitor['isMonitoring']).toBe(false);
    });

    it('should collect memory statistics', () => {
      const stats = monitor.getCurrentMemoryStats();

      expect(stats).toHaveProperty('heapUsed');
      expect(stats).toHaveProperty('heapTotal');
      expect(stats).toHaveProperty('rss');
      expect(stats.heapUsed).toBeGreaterThan(0);
      expect(stats.timestamp).toBeGreaterThan(0);
    });

    it('should maintain memory history', (done) => {
      monitor.startMonitoring();

      setTimeout(() => {
        const history = monitor.getMemoryHistory();
        expect(history.length).toBeGreaterThan(0);
        expect(history[0]).toHaveProperty('heapUsed');
        done();
      }, 250); // Wait for at least 2 monitoring cycles
    });
  });

  describe('Failed Request Tracking (OAuth Loop Prevention)', () => {
    it('should track failed requests', () => {
      const result1 = monitor.trackFailedRequest('req1', { data: 'test' });
      expect(result1).toBe(true); // Can retry

      const result2 = monitor.trackFailedRequest('req1', { data: 'test' });
      expect(result2).toBe(true); // Can still retry

      expect(monitor['retryCounters'].get('req1')).toBe(2);
    });

    it('should prevent infinite retry loops', () => {
      // Simulate OAuth retry loop (Issue #9897 root cause)
      let canRetry = true;
      let retryCount = 0;

      while (canRetry && retryCount < 10) {
        canRetry = monitor.trackFailedRequest('oauth-request', { token: 'invalid' });
        retryCount++;
      }

      expect(canRetry).toBe(false); // Should stop retrying
      expect(retryCount).toBe(6); // 5 retries + 1 initial = 6 total
    });

    it('should clean up old retry counters', () => {
      // Add some failed requests
      monitor.trackFailedRequest('old-req', { data: 'test' });
      monitor.trackFailedRequest('newer-req', { data: 'test' });

      expect(monitor['retryCounters'].size).toBe(2);

      // Trigger cleanup
      monitor['performLightCleanup']();

      // Counters should be cleared
      expect(monitor['retryCounters'].size).toBe(0);
    });
  });

  describe('Response Caching', () => {
    it('should cache responses with size limits', () => {
      // Add many cache entries
      for (let i = 0; i < 250; i++) {
        monitor.cacheResponse(`key${i}`, { data: `value${i}` });
      }

      // Should be limited to prevent memory bloat
      expect(monitor['responseCache'].size).toBeLessThan(250);
    });

    it('should expire old cache entries', () => {
      monitor.cacheResponse('test-key', { data: 'test' });

      // Manually set old timestamp
      const cached = monitor['responseCache'].get('test-key');
      cached.timestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      monitor['responseCache'].set('test-key', cached);

      // Should return null for expired entry
      const result = monitor.getCachedResponse('test-key');
      expect(result).toBeNull();

      // Should be removed from cache
      expect(monitor['responseCache'].has('test-key')).toBe(false);
    });
  });

  describe('Memory Cleanup Strategies', () => {
    beforeEach(() => {
      // Add some data to clean up
      monitor.trackFailedRequest('req1', { data: 'test1' });
      monitor.trackFailedRequest('req2', { data: 'test2' });
      monitor.cacheResponse('cache1', { data: 'cached1' });
      monitor.cacheResponse('cache2', { data: 'cached2' });
    });

    it('should perform light cleanup', () => {
      const initialFailedRequests = monitor['failedRequests'].size;
      const initialCache = monitor['responseCache'].size;

      expect(initialFailedRequests).toBeGreaterThan(0);
      expect(initialCache).toBeGreaterThan(0);

      monitor['performLightCleanup']();

      // Some cleanup should have occurred
      expect(monitor['retryCounters'].size).toBe(0);
    });

    it('should perform aggressive cleanup', () => {
      monitor['performAggressiveCleanup']();

      // Most data should be cleared
      expect(monitor['failedRequests'].size).toBe(0);
      expect(monitor['retryCounters'].size).toBe(0);
      // Cache might have some recent entries remaining
    });

    it('should perform emergency cleanup', () => {
      monitor['performEmergencyCleanup']();

      // Everything should be cleared
      expect(monitor['failedRequests'].size).toBe(0);
      expect(monitor['responseCache'].size).toBe(0);
      expect(monitor['retryCounters'].size).toBe(0);
    });
  });

  describe('Memory Trend Analysis', () => {
    it('should calculate memory trends', () => {
      // Add some fake history data
      const now = Date.now();
      monitor['memoryHistory'] = [
        { heapUsed: 100, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 150, timestamp: now - 4000 },
        { heapUsed: 110, heapTotal: 210, external: 12, arrayBuffers: 6, rss: 160, timestamp: now - 3000 },
        { heapUsed: 120, heapTotal: 220, external: 14, arrayBuffers: 7, rss: 170, timestamp: now - 2000 },
        { heapUsed: 130, heapTotal: 230, external: 16, arrayBuffers: 8, rss: 180, timestamp: now - 1000 },
        { heapUsed: 140, heapTotal: 240, external: 18, arrayBuffers: 9, rss: 190, timestamp: now }
      ];

      const trend = monitor['calculateMemoryTrend']();
      expect(trend).toBe('increasing');
    });

    it('should detect stable memory usage', () => {
      // Add stable memory history
      const now = Date.now();
      monitor['memoryHistory'] = [
        { heapUsed: 100, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 150, timestamp: now - 4000 },
        { heapUsed: 105, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 155, timestamp: now - 3000 },
        { heapUsed: 95, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 145, timestamp: now - 2000 },
        { heapUsed: 102, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 152, timestamp: now - 1000 },
        { heapUsed: 98, heapTotal: 200, external: 10, arrayBuffers: 5, rss: 148, timestamp: now }
      ];

      const trend = monitor['calculateMemoryTrend']();
      expect(trend).toBe('stable');
    });
  });

  describe('Configuration Updates', () => {
    it('should update thresholds', () => {
      const newConfig: Partial<MemoryConfig> = {
        thresholds: {
          warning: 500,
          critical: 1000,
          cleanup: 2000,
          emergency: 5000
        }
      };

      monitor.updateConfig(newConfig);

      expect(monitor['config'].thresholds.warning).toBe(500);
      expect(monitor['config'].thresholds.emergency).toBe(5000);
    });
  });
});

describe('MemoryMonitorPlugin', () => {
  let plugin: ReturnType<typeof createMemoryMonitorPlugin>;

  beforeEach(() => {
    plugin = createMemoryMonitorPlugin({
      autoStart: false,
      thresholds: {
        warning: 10,
        critical: 20,
        cleanup: 30,
        emergency: 50
      }
    });
  });

  afterEach(() => {
    plugin.shutdown();
  });

  describe('Plugin Management', () => {
    it('should initialize with config', () => {
      const status = plugin.getMemoryStatus();
      expect(status).toHaveProperty('current');
      expect(status).toHaveProperty('trend');
      expect(status).toHaveProperty('isMonitoring');
    });

    it('should start and stop monitoring', () => {
      plugin.startMonitoring();

      const status = plugin.getMemoryStatus();
      expect(status.isMonitoring).toBe(true);

      plugin.stopMonitoring();

      const statusAfter = plugin.getMemoryStatus();
      expect(statusAfter.isMonitoring).toBe(false);
    });

    it('should provide memory diagnostics', () => {
      const diagnostics = plugin.getDiagnostics();

      expect(diagnostics).toHaveProperty('memoryStatus');
      expect(diagnostics).toHaveProperty('config');
      expect(diagnostics).toHaveProperty('uptime');
      expect(diagnostics).toHaveProperty('nodeVersion');
    });
  });

  describe('OAuth Loop Prevention Integration', () => {
    it('should prevent OAuth retry loops through plugin interface', () => {
      let canRetry = true;
      let attemptCount = 0;

      // Simulate OAuth authentication failure loop
      while (canRetry && attemptCount < 10) {
        canRetry = plugin.trackFailedRequest(`oauth-${attemptCount}`, {
          type: 'oauth',
          error: 'invalid_token',
          timestamp: Date.now()
        });
        attemptCount++;
      }

      // Should stop retrying after 5 attempts
      expect(attemptCount).toBeLessThanOrEqual(6);
      expect(canRetry).toBe(false);
    });
  });

  describe('Cache Management Integration', () => {
    it('should manage response cache through plugin interface', () => {
      // Cache some responses
      plugin.cacheResponse('response1', { data: 'large response data' });
      plugin.cacheResponse('response2', { data: 'another large response' });

      // Should retrieve cached responses
      const cached1 = plugin.getCachedResponse('response1');
      expect(cached1).toEqual({ data: 'large response data' });

      // Should return null for non-existent cache
      const notCached = plugin.getCachedResponse('nonexistent');
      expect(notCached).toBeNull();
    });
  });

  describe('Force Cleanup', () => {
    it('should force different levels of cleanup', () => {
      // Add some data
      plugin.trackFailedRequest('req1', { data: 'test' });
      plugin.cacheResponse('cache1', { data: 'test' });

      // Light cleanup
      expect(() => plugin.forceCleanup('light')).not.toThrow();

      // Aggressive cleanup
      expect(() => plugin.forceCleanup('aggressive')).not.toThrow();

      // Emergency cleanup
      expect(() => plugin.forceCleanup('emergency')).not.toThrow();
    });
  });
});

describe('Logger Memory Safety', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('TestLogger', LogLevel.DEBUG);
  });

  it('should limit log history size', () => {
    // Add many log entries
    for (let i = 0; i < 1000; i++) {
      logger.info(`Test message ${i}`);
    }

    const memory = logger.getMemoryUsage();
    expect(memory.entriesCount).toBeLessThanOrEqual(500); // Should be limited
  });

  it('should sanitize large context objects', () => {
    const largeObject = {
      data: 'x'.repeat(2000) // Large string
    };

    // Should not throw and should handle large objects safely
    expect(() => logger.info('Test with large object', largeObject)).not.toThrow();
  });

  it('should clear history for memory management', () => {
    logger.info('Test message 1');
    logger.info('Test message 2');

    expect(logger.getMemoryUsage().entriesCount).toBe(2);

    logger.clearHistory();

    // Should have only the "cleared" message
    expect(logger.getMemoryUsage().entriesCount).toBe(1);
  });
});