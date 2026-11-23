"use client";

/**
 * 生成等待时长常数（给 ImagePlayground 的 showProgress 自动收起 ETA 用）。
 * 用户可见进度条已迁到 ParticleSeaWaiting，且进度契约见 src/lib/waiting-contract.ts：
 * 无真分母只做流动指示，禁止时间假百分比。
 * 本档只保留时长常数，不再提供任何时间估算进度函数。
 */
export const NORMAL_PROGRESS_DURATION_MS = 50000;
export const FALLBACK_PROGRESS_DURATION_MS = 80000;
