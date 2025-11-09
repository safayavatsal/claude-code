/**
 * Enhanced Logger for Memory Monitoring
 * Optimized to prevent contributing to memory issues
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: any;
  component: string;
}

export class Logger {
  private logLevel: LogLevel;
  private component: string;
  private logHistory: LogEntry[] = [];
  private maxHistorySize: number = 500; // Reduced from 1000 to prevent memory bloat

  constructor(component: string = 'MemoryMonitor', logLevel: LogLevel = LogLevel.INFO) {
    this.component = component;
    this.logLevel = logLevel;
  }

  debug(message: string, context?: any): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: any): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: any): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: any): void {
    this.log(LogLevel.ERROR, message, context);
  }

  private log(level: LogLevel, message: string, context?: any): void {
    if (level < this.logLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
      context: this.sanitizeContext(context), // Prevent large objects from bloating memory
      component: this.component
    };

    // Add to history with automatic cleanup
    this.logHistory.push(entry);
    if (this.logHistory.length > this.maxHistorySize) {
      // Remove oldest 20% of entries when limit reached
      const toRemove = Math.floor(this.maxHistorySize * 0.2);
      this.logHistory.splice(0, toRemove);
    }

    // Console output with memory-conscious formatting
    this.outputToConsole(entry);
  }

  private sanitizeContext(context: any): any {
    if (!context) return context;

    // Prevent logging large objects that could contribute to memory issues
    if (typeof context === 'object') {
      const stringified = JSON.stringify(context);
      if (stringified.length > 1000) {
        return '[Large Object - truncated for memory safety]';
      }
    }

    return context;
  }

  private outputToConsole(entry: LogEntry): void {
    const colorCode = this.getColorCode(LogLevel[entry.level as keyof typeof LogLevel]);
    const contextStr = entry.context && typeof entry.context !== 'string'
      ? ` | ${JSON.stringify(entry.context)}`
      : entry.context ? ` | ${entry.context}` : '';

    console.log(`${colorCode}[${entry.timestamp}] [${this.component}] ${entry.level}: ${entry.message}${contextStr}\x1b[0m`);
  }

  private getColorCode(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return '\x1b[36m'; // Cyan
      case LogLevel.INFO: return '\x1b[32m';  // Green
      case LogLevel.WARN: return '\x1b[33m';  // Yellow
      case LogLevel.ERROR: return '\x1b[31m'; // Red
      default: return '\x1b[0m';              // Reset
    }
  }

  /**
   * Get recent log entries (memory-safe)
   */
  getRecentLogs(count: number = 50): LogEntry[] {
    const safeCount = Math.min(count, this.logHistory.length);
    return this.logHistory.slice(-safeCount);
  }

  /**
   * Export logs with size limit
   */
  exportLogs(maxEntries: number = 100): string {
    const entries = this.logHistory.slice(-maxEntries);
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Clear log history (important for memory management)
   */
  clearHistory(): void {
    this.logHistory = [];
    this.info('Log history cleared for memory management');
  }

  /**
   * Set log level
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
    this.info('Log level changed', { newLevel: LogLevel[level] });
  }

  /**
   * Get memory usage of logger itself
   */
  getMemoryUsage(): { entriesCount: number; estimatedSizeKB: number } {
    const entriesCount = this.logHistory.length;
    const estimatedSizeKB = Math.round(JSON.stringify(this.logHistory).length / 1024);

    return { entriesCount, estimatedSizeKB };
  }
}