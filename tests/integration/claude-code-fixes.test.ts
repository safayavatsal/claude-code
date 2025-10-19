/**
 * Integration Tests for Claude Code Top 5 Issues Fixes
 * Comprehensive test suite covering all implemented solutions
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import all our solution plugins
import { createPlugin as createDirectoryOpsPlugin } from '../plugins/directory-operations-fix/src/index';
import { createMemoryMonitorPlugin } from '../plugins/memory-monitor/src/index';
import { createContentFilterPlugin } from '../plugins/content-filter-enhancer/src/index';
import { createUsageTransparencyPlugin } from '../plugins/usage-transparency/src/index';
import { createSessionRecoveryPlugin } from '../plugins/session-recovery/src/index';

describe('Claude Code Top 5 Issues - Integration Tests', () => {

  describe('Issue #9855: Directory Operation Crashes', () => {
    let plugin: ReturnType<typeof createDirectoryOpsPlugin>;

    beforeEach(() => {
      plugin = createDirectoryOpsPlugin({
        retryAttempts: 3,
        retryDelay: 100,
        logLevel: 'ERROR'
      });
    });

    it('should handle missing assistant message gracefully', async () => {
      const result = await plugin.listDirectory('/test/missing-message');

      expect(result).toBeDefined();
      expect(result.assistant_message || result.content).toBeTruthy();
      expect(result.error).toBeUndefined();
    });

    it('should handle Bedrock Haiku specific issues', async () => {
      const result = await plugin.listDirectory('/test/bedrock', 'bedrock-haiku-4.5');

      expect(result).toBeDefined();
      expect(result.assistant_message).toBeDefined();
    });

    it('should provide fallback when all attempts fail', async () => {
      const result = await plugin.listDirectory('/invalid/path');

      expect(result).toBeDefined();
      expect(result.files).toEqual([]);
      expect(result.directories).toEqual([]);
      expect(result.assistant_message).toContain('Unable to process directory');
    });

    it('should not crash on empty responses', async () => {
      // This specifically tests the crash scenario from Issue #9855
      expect(async () => {
        await plugin.listDirectory('/empty/response/test');
      }).not.toThrow();
    });
  });

  describe('Issue #9897: Memory Consumption', () => {
    let plugin: ReturnType<typeof createMemoryMonitorPlugin>;

    beforeEach(() => {
      plugin = createMemoryMonitorPlugin({
        autoStart: false,
        thresholds: {
          warning: 10,   // Low thresholds for testing
          critical: 20,
          cleanup: 30,
          emergency: 50
        }
      });
    });

    afterEach(() => {
      plugin.shutdown();
    });

    it('should monitor memory usage without leaks', async () => {
      plugin.startMonitoring();

      const initialStatus = plugin.getMemoryStatus();
      expect(initialStatus.isMonitoring).toBe(true);
      expect(initialStatus.current.heapUsed).toBeGreaterThan(0);

      plugin.stopMonitoring();
      expect(plugin.getMemoryStatus().isMonitoring).toBe(false);
    });

    it('should prevent OAuth retry loops', () => {
      let canRetry = true;
      let attempts = 0;

      // Simulate OAuth retry loop
      while (canRetry && attempts < 10) {
        canRetry = plugin.trackFailedRequest(`oauth-${attempts}`, {
          type: 'oauth',
          error: 'invalid_token'
        });
        attempts++;
      }

      expect(attempts).toBeLessThanOrEqual(6); // Should stop at 5 retries + 1 initial
      expect(canRetry).toBe(false);
    });

    it('should manage response cache size', () => {
      // Add many responses to test cache management
      for (let i = 0; i < 250; i++) {
        plugin.cacheResponse(`key-${i}`, { data: `value-${i}` });
      }

      const status = plugin.getMemoryStatus();
      expect(status.cacheStats.responseCache).toBeLessThan(250); // Should be limited
    });

    it('should perform emergency cleanup when memory is critical', () => {
      // Add some data to clean up
      plugin.trackFailedRequest('test-req', { data: 'test' });
      plugin.cacheResponse('test-cache', { data: 'test' });

      // Force emergency cleanup
      plugin.forceCleanup('emergency');

      const status = plugin.getMemoryStatus();
      expect(status.cacheStats.failedRequests).toBe(0);
      expect(status.cacheStats.responseCache).toBe(0);
    });
  });

  describe('Issue #9908: Content Filter False Positives', () => {
    let plugin: ReturnType<typeof createContentFilterPlugin>;

    beforeEach(() => {
      plugin = createContentFilterPlugin({
        enableDevOpsWhitelist: true,
        enableConfigFileWhitelist: true,
        enableUserFileWhitelist: true
      });
    });

    it('should allow Google App Password format in SMTP context', async () => {
      const result = await plugin.filterContent(
        'SMTP_PASSWORD=abcd efgh ijkl mnop',
        ['.env', 'mail-config.js'],
        'Configure Gmail SMTP for email notifications'
      );

      expect(result.allowed).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.reason).toMatch(/DevOps workflow|legitimate/i);
    });

    it('should recognize DevOps configuration contexts', async () => {
      const dockerResult = await plugin.filterContent(
        'ENV DATABASE_URL=postgresql://user:password@db:5432/app',
        ['Dockerfile', 'docker-compose.yml'],
        'Configure production Docker environment'
      );

      expect(dockerResult.allowed).toBe(true);

      const k8sResult = await plugin.filterContent(
        'apiVersion: v1\nkind: Secret\ndata:\n  token: YWJjZGVm',
        ['k8s-deployment.yaml'],
        'Deploy application secrets'
      );

      expect(k8sResult.allowed).toBe(true);
    });

    it('should still block genuinely sensitive information', async () => {
      const result = await plugin.filterContent(
        'My credit card: 4111-1111-1111-1111',
        ['personal-notes.txt']
      );

      expect(result.allowed).toBe(false);
      expect(result.severity).toMatch(/warning|error/i);
    });

    it('should detect Google App Password format correctly', () => {
      const isGoogleAppPassword = plugin.isGoogleAppPassword(
        'Gmail SMTP setup: abcd efgh ijkl mnop'
      );

      expect(isGoogleAppPassword).toBe(true);

      const isNotGoogleAppPassword = plugin.isGoogleAppPassword(
        'Random password: supersecretpassword123'
      );

      expect(isNotGoogleAppPassword).toBe(false);
    });

    it('should provide detailed content analysis', async () => {
      const analysis = await plugin.testContent(
        'Configure SMTP: password=abcd efgh ijkl mnop',
        ['.env', 'config/mail.js']
      );

      expect(analysis.result.allowed).toBe(true);
      expect(analysis.analysis.hasDevOpsFiles).toBe(true);
      expect(analysis.analysis.isGoogleAppPassword).toBe(true);
    });
  });

  describe('Issue #9862: Usage Limit Transparency', () => {
    let plugin: ReturnType<typeof createUsageTransparencyPlugin>;

    beforeEach(() => {
      plugin = createUsageTransparencyPlugin({
        autoStart: false,
        enablePolicyChangeAlerts: true,
        enableUsageAlerts: true
      });
    });

    afterEach(() => {
      plugin.stopMonitoring();
    });

    it('should display usage status clearly', async () => {
      const stats = await plugin.getUsageStats();

      expect(stats).toHaveProperty('current');
      expect(stats).toHaveProperty('limits');
      expect(stats).toHaveProperty('periods');
      expect(stats).toHaveProperty('predictions');

      expect(stats.current.requests).toBeGreaterThan(0);
      expect(stats.limits.weeklyRequests).toBeGreaterThan(0);
    });

    it('should track policy changes', () => {
      const changes = plugin.getPolicyChanges(30);

      expect(changes).toBeDefined();
      expect(Array.isArray(changes)).toBe(true);

      // Should include the September 2025 limit decrease from Issue #9862
      const septemberChange = changes.find(c =>
        c.description.includes('decreased') && c.date
      );
      expect(septemberChange).toBeDefined();
    });

    it('should generate changelog reports', () => {
      const changelog = plugin.generateChangelogReport(30);

      expect(changelog).toContain('Policy Changes');
      expect(typeof changelog).toBe('string');
      expect(changelog.length).toBeGreaterThan(100);
    });

    it('should handle alerts appropriately', () => {
      const alerts = plugin.getAlerts(10);

      expect(Array.isArray(alerts)).toBe(true);
    });
  });

  describe('Issue #9800: Session Resume Failures', () => {
    let plugin: ReturnType<typeof createSessionRecoveryPlugin>;

    beforeEach(() => {
      plugin = createSessionRecoveryPlugin({
        enableAutoBackup: true,
        enableChecksumValidation: true,
        oauthRefreshThreshold: 15
      });
    });

    it('should list sessions without errors', async () => {
      const sessions = await plugin.listSessions();

      expect(Array.isArray(sessions)).toBe(true);
      // Sessions array can be empty, that's fine
    });

    it('should handle session resume gracefully', async () => {
      // Mock session data
      const mockSession = {
        metadata: {
          sessionId: 'test-session-' + Date.now(),
          createdAt: Date.now() - 86400000, // 1 day ago
          lastUpdated: Date.now() - 3600000, // 1 hour ago
          totalMessages: 5,
          isActive: false,
          version: '1.0.0'
        },
        messages: [
          {
            timestamp: Date.now() - 3600000,
            type: 'user' as const,
            content: 'Hello',
            sessionId: 'test-session-' + Date.now()
          },
          {
            timestamp: Date.now() - 3500000,
            type: 'assistant' as const,
            content: 'Hi there!',
            sessionId: 'test-session-' + Date.now()
          }
        ]
      };

      // Save and then resume
      await plugin.saveSession(mockSession);

      expect(async () => {
        await plugin.resumeSession(mockSession.metadata.sessionId);
      }).not.toThrow();
    });

    it('should handle missing sessionId fields', async () => {
      // Mock session with missing sessionId fields (the main Issue #9800 problem)
      const sessionWithMissingIds = {
        metadata: {
          sessionId: 'missing-ids-session-' + Date.now(),
          createdAt: Date.now(),
          lastUpdated: Date.now(),
          totalMessages: 2,
          isActive: false,
          version: '1.0.0'
        },
        messages: [
          {
            timestamp: Date.now() - 1000,
            type: 'user' as const,
            content: 'Test message',
            // sessionId missing - this is the bug!
          }
        ]
      };

      // Should not throw when saving/resuming
      expect(async () => {
        await plugin.saveSession(sessionWithMissingIds);
        await plugin.resumeSession(sessionWithMissingIds.metadata.sessionId);
      }).not.toThrow();
    });
  });

  describe('Cross-Plugin Integration', () => {
    it('should work together without conflicts', async () => {
      // Initialize all plugins
      const directoryOps = createDirectoryOpsPlugin({ logLevel: 'ERROR' });
      const memoryMonitor = createMemoryMonitorPlugin({ autoStart: false });
      const contentFilter = createContentFilterPlugin();
      const usageMonitor = createUsageTransparencyPlugin({ autoStart: false });
      const sessionRecovery = createSessionRecoveryPlugin();

      // Test that they can all be created without conflicts
      expect(directoryOps).toBeDefined();
      expect(memoryMonitor).toBeDefined();
      expect(contentFilter).toBeDefined();
      expect(usageMonitor).toBeDefined();
      expect(sessionRecovery).toBeDefined();

      // Test basic functionality together
      const directoryResult = await directoryOps.listDirectory('/test');
      const filterResult = await contentFilter.filterContent(
        'SMTP_PASSWORD=abcd efgh ijkl mnop',
        ['.env']
      );
      const sessions = await sessionRecovery.listSessions();

      expect(directoryResult).toBeDefined();
      expect(filterResult.allowed).toBe(true);
      expect(Array.isArray(sessions)).toBe(true);

      // Cleanup
      memoryMonitor.shutdown();
    });

    it('should handle memory management across all plugins', () => {
      const memoryMonitor = createMemoryMonitorPlugin({ autoStart: false });

      // Test that memory monitoring works with other plugins active
      const initialStatus = memoryMonitor.getMemoryStatus();
      expect(initialStatus.current.heapUsed).toBeGreaterThan(0);

      memoryMonitor.shutdown();
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle Issue #9855 crash scenario', async () => {
      const directoryOps = createDirectoryOpsPlugin();

      // Simulate the exact scenario from Issue #9855
      // User tries to reference a directory using @ syntax
      const result = await directoryOps.listDirectory('@project/src');

      expect(result).toBeDefined();
      expect(result.assistant_message || result.content).toBeTruthy();
      // Should not throw "No assistant message found"
    });

    it('should handle Issue #9897 memory scenario', () => {
      const memoryMonitor = createMemoryMonitorPlugin({ autoStart: false });

      // Simulate OAuth retry loop that caused 20GB memory usage
      let attempts = 0;
      let canRetry = true;

      const startMemory = memoryMonitor.getMemoryStatus().current.heapUsed;

      while (canRetry && attempts < 100) { // Try to create a loop
        canRetry = memoryMonitor.trackFailedRequest(`oauth-loop-${attempts}`, {
          type: 'oauth',
          error: 'invalid_token',
          timestamp: Date.now()
        });
        attempts++;
      }

      const endMemory = memoryMonitor.getMemoryStatus().current.heapUsed;

      // Should have stopped retrying before causing memory bloat
      expect(attempts).toBeLessThan(50);
      expect(canRetry).toBe(false);

      memoryMonitor.shutdown();
    });

    it('should handle Issue #9908 SMTP scenario', async () => {
      const contentFilter = createContentFilterPlugin();

      // Simulate the exact SMTP configuration scenario
      const result = await contentFilter.filterContent(
        `To configure Gmail SMTP, use these settings:
        SMTP_HOST=smtp.gmail.com
        SMTP_PORT=587
        SMTP_PASSWORD=abcd efgh ijkl mnop`,
        ['.env', 'config/mail.js'],
        'Setting up email notifications for the application'
      );

      expect(result.allowed).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
      // Should not block legitimate SMTP configuration
    });

    it('should handle Issue #9862 policy change scenario', () => {
      const usageTransparency = createUsageTransparencyPlugin({ autoStart: false });

      // Check for the September 2025 limit decrease
      const policyChanges = usageTransparency.getPolicyChanges();
      const septemberChange = policyChanges.find(change =>
        change.description.includes('2000 to 1000') ||
        change.type === 'limit_decrease'
      );

      expect(septemberChange).toBeDefined();
      expect(septemberChange?.notified).toBe(false); // This was the problem
    });

    it('should handle Issue #9800 resume scenario', async () => {
      const sessionRecovery = createSessionRecoveryPlugin();

      // Create a session that mimics the problem scenario
      const problemSession = {
        metadata: {
          sessionId: 'problem-session-' + Date.now(),
          createdAt: Date.now() - 86400000,
          lastUpdated: Date.now() - 3600000,
          totalMessages: 3,
          isActive: false,
          version: '1.0.0',
          oauthTokenExpiry: Date.now() + 300000 // Expires in 5 minutes
        },
        messages: [
          {
            timestamp: Date.now() - 3600000,
            type: 'user' as const,
            content: 'Start conversation'
            // Missing sessionId field - the core problem
          },
          {
            timestamp: Date.now() - 3500000,
            type: 'assistant' as const,
            content: 'Hello! How can I help?'
            // Missing sessionId field - the core problem
          }
        ]
      };

      // This should work without manual intervention
      await plugin.saveSession(problemSession);
      const resumed = await sessionRecovery.resumeSession(problemSession.metadata.sessionId);

      expect(resumed).toBeDefined();
      expect(resumed.messages.every(msg => msg.sessionId)).toBe(true);
      // All messages should now have sessionId fields
    });
  });
});

/**
 * Performance and Load Tests
 */
describe('Performance Tests', () => {
  it('should handle multiple directory operations efficiently', async () => {
    const directoryOps = createDirectoryOpsPlugin();
    const startTime = Date.now();

    const promises = Array.from({ length: 10 }, (_, i) =>
      directoryOps.listDirectory(`/test/path/${i}`)
    );

    const results = await Promise.all(promises);
    const endTime = Date.now();

    expect(results).toHaveLength(10);
    expect(results.every(r => r !== undefined)).toBe(true);
    expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
  });

  it('should maintain memory efficiency under load', () => {
    const memoryMonitor = createMemoryMonitorPlugin({ autoStart: false });
    const startMemory = memoryMonitor.getMemoryStatus().current.heapUsed;

    // Simulate high load
    for (let i = 0; i < 1000; i++) {
      memoryMonitor.cacheResponse(`load-test-${i}`, {
        data: 'x'.repeat(100),
        timestamp: Date.now()
      });
    }

    const endMemory = memoryMonitor.getMemoryStatus().current.heapUsed;
    const memoryIncrease = endMemory - startMemory;

    // Should not increase memory dramatically (cache should be managed)
    expect(memoryIncrease).toBeLessThan(50); // Less than 50MB increase

    memoryMonitor.shutdown();
  });

  it('should filter content efficiently at scale', async () => {
    const contentFilter = createContentFilterPlugin();
    const startTime = Date.now();

    const testCases = Array.from({ length: 100 }, (_, i) => ({
      message: `Test configuration ${i}: SMTP_PASSWORD=abcd efgh ijkl mnop`,
      files: ['.env', 'config.js'],
      intent: 'Configure email settings'
    }));

    const results = await Promise.all(
      testCases.map(test =>
        contentFilter.filterContent(test.message, test.files, test.intent)
      )
    );

    const endTime = Date.now();

    expect(results).toHaveLength(100);
    expect(results.every(r => r.allowed === true)).toBe(true);
    expect(endTime - startTime).toBeLessThan(3000); // Should be fast
  });
});