'use client';

import { useEffect, useMemo, useState } from 'react';

const MIN_PODS = 3;
const MAX_PODS = 12;
const POD_CAPACITY_RPS = 20;
const TARGET_UTILIZATION = 0.7;
const PGBOUNCER_CAPACITY_RPS = 80;
const HPA_OBSERVES_AT = 5;
const NEW_PODS_READY_AT = 15;
const BAD_REQUEST_AT = 2;
const READINESS_REMOVES_AT = 6;
const BAD_POD_RECOVERS_AT = 20;
const END_TIME = 60;

type PodState = 'ready' | 'blocked' | 'unready' | 'starting';

function desiredPods(loadRps: number) {
  return Math.min(MAX_PODS, Math.max(MIN_PODS, Math.ceil(loadRps / (POD_CAPACITY_RPS * TARGET_UTILIZATION))));
}

function podState(id: number, time: number, blockOnePod: boolean, desired: number): PodState | null {
  if (id > MIN_PODS) {
    if (id > desired || time < HPA_OBSERVES_AT) return null;
    return time < NEW_PODS_READY_AT ? 'starting' : 'ready';
  }
  if (id !== 1 || !blockOnePod) return 'ready';
  if (time < BAD_REQUEST_AT || time >= BAD_POD_RECOVERS_AT) return 'ready';
  if (time < READINESS_REMOVES_AT) return 'blocked';
  return 'unready';
}

function healthyPodsAt(time: number, blockOnePod: boolean, desired: number) {
  let healthy = MIN_PODS;
  if (blockOnePod && time >= BAD_REQUEST_AT && time < BAD_POD_RECOVERS_AT) healthy -= 1;
  if (time >= NEW_PODS_READY_AT) healthy += Math.max(0, desired - MIN_PODS);
  return healthy;
}

/** Integrate the backlog over the simulated timeline. This teaches direction, not a capacity forecast. */
function queueAt(time: number, loadRps: number, blockOnePod: boolean, desired: number) {
  let queue = 0;
  const step = 0.05;
  for (let cursor = 0; cursor < time; cursor += step) {
    const nodeCapacity = healthyPodsAt(cursor, blockOnePod, desired) * POD_CAPACITY_RPS;
    const capacity = Math.min(nodeCapacity, PGBOUNCER_CAPACITY_RPS);
    queue = Math.max(0, queue + (loadRps - capacity) * Math.min(step, time - cursor));
  }
  return queue;
}

export default function AutoscalingSimulator() {
  const [loadRps, setLoadRps] = useState(70);
  const [blockOnePod, setBlockOnePod] = useState(true);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setTime(current => {
        if (current >= END_TIME) {
          setPlaying(false);
          return END_TIME;
        }
        return Math.min(END_TIME, current + 0.5);
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [playing]);

  const model = useMemo(() => {
    const desired = desiredPods(loadRps);
    const pods = Array.from({ length: desired }, (_, index) => {
      const id = index + 1;
      return { id, state: podState(id, time, blockOnePod, desired) };
    }).filter((pod): pod is { id: number; state: PodState } => pod.state !== null);
    const healthy = healthyPodsAt(time, blockOnePod, desired);
    const nodeCapacity = healthy * POD_CAPACITY_RPS;
    const effectiveCapacity = Math.min(nodeCapacity, PGBOUNCER_CAPACITY_RPS);
    const queue = queueAt(time, loadRps, blockOnePod, desired);
    const bottleneck = loadRps > effectiveCapacity
      ? nodeCapacity <= PGBOUNCER_CAPACITY_RPS ? 'Node pods' : 'PgBouncer'
      : queue > 0 ? 'draining' : 'none';
    const phase = time < HPA_OBSERVES_AT
      ? 'HPA is waiting for a metrics sample'
      : time < NEW_PODS_READY_AT && desired > MIN_PODS
        ? `HPA requested ${desired - MIN_PODS} more pod${desired - MIN_PODS === 1 ? '' : 's'}; they are starting`
        : desired > MIN_PODS
          ? 'New pods are ready and receiving traffic'
          : 'Current replicas can handle the target load';
    return { desired, pods, healthy, nodeCapacity, effectiveCapacity, queue, bottleneck, phase };
  }, [blockOnePod, loadRps, time]);

  function restart() {
    setTime(0);
    setPlaying(true);
  }

  return (
    <section className="card autoscaleLab" id="autoscaling">
      <div className="autoscaleHeading">
        <div>
          <p className="sectionNumber">INTERACTIVE LAB</p>
          <h2>Autoscaling an event-loop service</h2>
        </div>
        <p>Increase load, then follow traffic through ready Node pods and the shared database gate. One simulated second passes every 240ms.</p>
      </div>

      <div className="autoscaleControls">
        <label>
          <span>Incoming load <strong>{loadRps} req/s</strong></span>
          <input type="range" min="20" max="120" step="10" value={loadRps} onChange={event => { setLoadRps(Number(event.target.value)); setTime(0); setPlaying(false); }} />
        </label>
        <label className="blockToggle">
          <input type="checkbox" checked={blockOnePod} onChange={event => { setBlockOnePod(event.target.checked); setTime(0); setPlaying(false); }} />
          <span>Pod 1 receives a CPU-heavy request</span>
        </label>
        <button type="button" className="runSimulation" onClick={restart}>Run scenario</button>
      </div>

      <div className="simClock">
        <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : time >= END_TIME ? 'Replay' : 'Play'}</button>
        <label><span>Time: {time.toFixed(1)}s</span><input aria-label="Simulation time" type="range" min="0" max={END_TIME} step="0.5" value={time} onChange={event => { setTime(Number(event.target.value)); setPlaying(false); }} /></label>
      </div>

      <div className="autoscaleStats" aria-live="polite">
        <div><span>Ready pods</span><strong>{model.healthy}</strong></div>
        <div><span>Effective capacity</span><strong>{model.effectiveCapacity} req/s</strong></div>
        <div><span>Queued requests</span><strong>{Math.round(model.queue)}</strong></div>
      </div>

      <div className="systemFlow">
        <div className="flowBox ingressBox"><span>Load balancer</span><strong>{loadRps} req/s</strong><small>routes only to ready pods</small></div>
        <div className="flowArrow" aria-hidden="true">→</div>
        <div className="podStage">
          <div className="stageLabel"><span>Node API deployment</span><strong>HPA target: {model.desired}</strong></div>
          <div className="podGrid">
            {model.pods.map(pod => <div className={`pod ${pod.state}`} key={pod.id}><b>Pod {pod.id}</b><span>{pod.state}</span><small>{pod.state === 'ready' ? '20 req/s' : pod.state === 'blocked' ? 'event loop stuck' : pod.state === 'unready' ? 'traffic removed' : 'warming up'}</small></div>)}
          </div>
        </div>
        <div className="flowArrow" aria-hidden="true">→</div>
        <div className="flowBox bouncerBox"><span>Shared PgBouncer</span><strong>80 req/s ceiling</strong><small>global database gate</small></div>
        <div className="flowArrow pgArrow" aria-hidden="true">→</div>
        <div className="flowBox postgresBox"><span>PostgreSQL</span><strong>protected</strong><small>bounded connections</small></div>
      </div>

      <div className="simStatus"><strong>{time.toFixed(1)}s</strong><span>{model.phase}</span><b>{model.bottleneck === 'none' ? 'No queue pressure' : model.bottleneck === 'draining' ? 'Spare capacity is draining the queue' : `${model.bottleneck} limits throughput`}</b></div>
      <div className="eventTrack" aria-label="Simulation events">
        <span style={{ left: '0%' }}><i />load spike</span>
        {blockOnePod && <span style={{ left: `${BAD_REQUEST_AT / END_TIME * 100}%` }}><i />pod blocked</span>}
        <span style={{ left: `${HPA_OBSERVES_AT / END_TIME * 100}%` }}><i />HPA observes</span>
        {blockOnePod && <span className="eventBelow" style={{ left: `${READINESS_REMOVES_AT / END_TIME * 100}%` }}><i />unready</span>}
        <span style={{ left: `${NEW_PODS_READY_AT / END_TIME * 100}%` }}><i />new pods ready</span>
        {blockOnePod && <span className="eventEnd" style={{ left: `${BAD_POD_RECOVERS_AT / END_TIME * 100}%` }}><i />pod recovers</span>}
        <div className="eventProgress" style={{ width: `${time / END_TIME * 100}%` }} />
      </div>
      <p className="modelNote">Model assumptions: 3 minimum pods, 20 req/s per healthy pod, HPA target 70%, five-second observation, ten-second startup, and an 80 req/s shared PgBouncer ceiling. These values teach the flow; they are not Kubernetes defaults or capacity recommendations.</p>
    </section>
  );
}
