import type { BodyEndpoint } from "./types.js";

export interface EndpointSummary {
  bodyId: string;
  bodyType: string;
  online: boolean;
  fault?: string;
  isFocal: boolean;
  isPaused: boolean;
}

/**
 * 具身路由器 (Body Router)
 *
 * 负责端点注册、意图路由、焦点管理与单身体暂停/恢复。
 * 纯内存管理，零向外强依赖。
 */
export class BodyRouter {
  private readonly endpoints = new Map<string, BodyEndpoint>();
  private readonly pausedBodies = new Set<string>();
  private primaryBodyId?: string;

  /**
   * 注册具身端点
   */
  registerEndpoint(endpoint: BodyEndpoint): void {
    this.endpoints.set(endpoint.bodyId, endpoint);
    // 第一个注册的端点默认成为主导焦点
    if (!this.primaryBodyId) {
      this.primaryBodyId = endpoint.bodyId;
      endpoint.onFocus?.(true);
    }
  }

  /**
   * 注销具身端点
   */
  unregisterEndpoint(bodyId: string): void {
    const ep = this.endpoints.get(bodyId);
    if (ep && this.primaryBodyId === bodyId) {
      ep.onFocus?.(false);
    }
    this.endpoints.delete(bodyId);
    this.pausedBodies.delete(bodyId);

    if (this.primaryBodyId === bodyId) {
      // 焦点后移至下一个活跃端点
      const nextKey = this.endpoints.keys().next().value as string | undefined;
      this.primaryBodyId = nextKey;
      if (nextKey) {
        this.endpoints.get(nextKey)?.onFocus?.(true);
      }
    }
  }

  /**
   * 获取端点
   */
  getEndpoint(bodyId: string): BodyEndpoint | undefined {
    return this.endpoints.get(bodyId);
  }

  /**
   * 获取当前主导端点
   */
  getPrimaryEndpoint(): BodyEndpoint | undefined {
    return this.primaryBodyId ? this.endpoints.get(this.primaryBodyId) : undefined;
  }

  /**
   * 获取当前主导端点 ID
   */
  getPrimaryBodyId(): string | undefined {
    return this.primaryBodyId;
  }

  /**
   * 查询单个端点快照——summary 形状的唯一事实源（listEndpoints 复用）。
   */
  summaryOf(bodyId: string): EndpointSummary | undefined {
    const ep = this.endpoints.get(bodyId);
    if (!ep) return undefined;
    const state = ep.state();
    return {
      bodyId,
      bodyType: ep.bodyType,
      online: state.online,
      fault: state.fault,
      isFocal: this.primaryBodyId === bodyId,
      isPaused: this.pausedBodies.has(bodyId),
    };
  }

  /**
   * 查询所有端点快照
   */
  listEndpoints(): EndpointSummary[] {
    return Array.from(this.endpoints.keys(), (id) => this.summaryOf(id)!);
  }

	/**
   * 分发伴随线索 (Track A)
   */
  dispatchCue(cueId: string, target?: string): boolean {
    // 投递一段并归一化异常：emitCue 抛错按派发失败处理，不让单个端点拖垮整轮。
    const deliver = (ep: BodyEndpoint): boolean => {
      try {
        ep.emitCue(cueId);
        return true;
      } catch {
        return false;
      }
    };

    if (target) {
      // 显式定向分发
      const ep = this.endpoints.get(target);
      if (!ep || this.pausedBodies.has(target) || !ep.state().online) {
        return false;
      }
      return deliver(ep);
    }

    // 隐式语义分发：扫描支持该 cue 的非暂停、在线端点
    const candidates: BodyEndpoint[] = [];
    for (const [id, ep] of this.endpoints.entries()) {
      if (this.pausedBodies.has(id) || !ep.state().online) {
        continue;
      }
      // 匹配的是端点**声明的响应集合**（id + 别名）；派发时传原始 cueId，
      // 别名→规范 id 的归一化由端点自己完成（宿主不解释语义）。
      const affords = ep.affordance().cues.some(
        (c) => c.id === cueId || c.aliases?.includes(cueId) === true,
      );
      if (affords) {
        candidates.push(ep);
      }
    }

    if (candidates.length === 0) {
      return false;
    }

    // 优先发给当前主导端点
    const primary = this.primaryBodyId
      ? candidates.find((c) => c.bodyId === this.primaryBodyId)
      : undefined;

    const targetEp = primary ?? candidates[0]!;
    return deliver(targetEp);
  }

  /**
   * 焦点切换
   */
  async setFocus(targetBodyId: string): Promise<boolean> {
    const newEp = this.endpoints.get(targetBodyId);
    if (!newEp) {
      return false;
    }
    if (this.primaryBodyId === targetBodyId) {
      return true;
    }

    const oldEp = this.primaryBodyId ? this.endpoints.get(this.primaryBodyId) : undefined;
    if (oldEp?.onFocus) {
      await oldEp.onFocus(false);
    }

    this.primaryBodyId = targetBodyId;

    if (newEp.onFocus) {
      await newEp.onFocus(true);
    }
    return true;
  }

  /**
   * 暂停特定身体
   */
  async pause(bodyId: string): Promise<boolean> {
    const ep = this.endpoints.get(bodyId);
    if (!ep) {
      return false;
    }
    this.pausedBodies.add(bodyId);
    await ep.safeStop();
    return true;
  }

  /**
   * 恢复特定身体
   */
  resume(bodyId: string): boolean {
    if (!this.endpoints.has(bodyId)) {
      return false;
    }
    this.pausedBodies.delete(bodyId);
    return true;
  }

  /**
   * 全身体急停
   */
  async stopAll(): Promise<void> {
    const tasks = Array.from(this.endpoints.values()).map((ep) => ep.safeStop());
    await Promise.allSettled(tasks);
  }
}
