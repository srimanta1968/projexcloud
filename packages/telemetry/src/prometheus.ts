/**
 * P10/E8 — minimal, dependency-free Prometheus exposition registry.
 * Counters/Gauges/Histograms render to the text exposition format scraped at
 * GET /metrics. Every metric is tagged with an observability `taxonomy` label
 * (one of the 8 types) so dashboards group cleanly.
 */

import { OBSERVABILITY_TYPES, type ObservabilityType } from './observability';

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',')}}`;
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly taxonomy: ObservabilityType,
  ) {}
  abstract type(): string;
  abstract render(): string[];
  protected baseLabels(labels: Labels): Labels {
    return { taxonomy: this.taxonomy, ...labels };
  }
}

export class Counter extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  type(): string {
    return 'counter';
  }
  inc(labels: Labels = {}, by = 1): void {
    const merged = this.baseLabels(labels);
    const key = labelKey(merged);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels: merged, value: by });
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      out.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return out;
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  type(): string {
    return 'gauge';
  }
  set(labels: Labels, value: number): void {
    const merged = this.baseLabels(labels);
    this.values.set(labelKey(merged), { labels: merged, value });
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      out.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return out;
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, taxonomy: ObservabilityType, readonly buckets = DEFAULT_BUCKETS) {
    super(name, help, taxonomy);
  }
  type(): string {
    return 'histogram';
  }
  observe(labels: Labels, value: number): void {
    const merged = this.baseLabels(labels);
    const key = labelKey(merged);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: merged, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += s.counts[i];
        out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: String(this.buckets[i]) })} ${cumulative}`);
      }
      out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

class Registry {
  private readonly metrics = new Map<string, Metric>();
  register<T extends Metric>(metric: T): T {
    this.metrics.set(metric.name, metric);
    return metric;
  }
  counter(name: string, help: string, taxonomy: ObservabilityType): Counter {
    const existing = this.metrics.get(name);
    if (existing instanceof Counter) return existing;
    return this.register(new Counter(name, help, taxonomy));
  }
  gauge(name: string, help: string, taxonomy: ObservabilityType): Gauge {
    const existing = this.metrics.get(name);
    if (existing instanceof Gauge) return existing;
    return this.register(new Gauge(name, help, taxonomy));
  }
  histogram(name: string, help: string, taxonomy: ObservabilityType): Histogram {
    const existing = this.metrics.get(name);
    if (existing instanceof Histogram) return existing;
    return this.register(new Histogram(name, help, taxonomy));
  }
  /** Renders the full registry in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) lines.push(...m.render());
    return lines.join('\n') + '\n';
  }
  /** Lists registered metric names grouped by taxonomy (dashboard wiring aid). */
  byTaxonomy(): Record<ObservabilityType, string[]> {
    const out = Object.fromEntries(OBSERVABILITY_TYPES.map((t) => [t, [] as string[]])) as Record<
      ObservabilityType,
      string[]
    >;
    for (const m of this.metrics.values()) out[m.taxonomy].push(m.name);
    return out;
  }
}

/** Process-wide metrics registry scraped at GET /metrics. */
export const registry = new Registry();
