import { connection } from "next/server";
import { loadResults, type Summary } from "./data";
import AutoscalingSimulator from "./autoscaling-simulator";

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)}s`;

function Metric({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function QueueDiagram({ selected }: { selected: Summary }) {
  const running = Math.min(selected.count, 10);
  const waiting = Math.max(0, selected.count - 10);
  return (
    <section className="diagram" aria-label={`For ${selected.count} requests, ${running} run and ${waiting} wait`}>
      <div className="diagramLabel">One burst</div>
      <div className="requestBubble">{selected.count}<small>requests</small></div>
      <div className="arrow" aria-hidden="true">→</div>
      <div className="connectionRoom">
        <div>
          <span className="roomLabel">Connection room</span>
          <strong>10 slots</strong>
        </div>
        <div className="slots" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => <i className={index < running ? "busy" : ""} key={index} />)}
        </div>
      </div>
      <div className="arrow" aria-hidden="true">→</div>
      <div className="queueBubble">
        <strong>{waiting}</strong>
        <small>{waiting === 1 ? "request waits" : "requests wait"}</small>
      </div>
    </section>
  );
}

export default async function Home() {
  // Read fresh lab files on every refresh instead of freezing them at build time.
  await connection();
  const { requestCounts, firstLab, arrivalRates, eventLoop } = await loadResults();
  if (!requestCounts.length) {
    return <main className="empty"><h1>No request-count results yet</h1><p>Run <code>npm run lab:requests</code> from the repository root, then refresh.</p></main>;
  }

  const largest = requestCounts.at(-1)!;
  const maxDrain = Math.max(...requestCounts.map((result) => result.workloadMs));
  const slowSql = firstLab.find((result) => result.name === "02-slow-sql");
  const blockedLoop = firstLab.find((result) => result.name === "03-blocked-loop");

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">POSTGRES CONNECTION QUEUE LAB</p>
          <h1>More requests create<br /><em>more waiting</em></h1>
          <p className="lede">One API process. Ten connections. Every query holds a connection for 500ms. We changed only the number of requests arriving together.</p>
        </div>
        <div className="stamp"><span>LAB 02</span><strong>BURST SIZE</strong><small>latest saved run</small></div>
      </header>

      <AutoscalingSimulator />

      <QueueDiagram selected={largest} />

      <section className="metrics" aria-label="Largest burst summary">
        <Metric value={`${largest.count}`} label="requests sent" note="all at once" />
        <Metric value={`${largest.peakNodeWaiting}`} label="peak waiters" note="inside Node pool" />
        <Metric value={seconds(largest.workloadMs)} label="drain time" note="until all finished" />
        <Metric value={`${largest.success}/${largest.count}`} label="successful" note={`${largest.errors} errors`} />
      </section>

      <section className="card chartCard">
        <div className="sectionHeading">
          <div><p className="sectionNumber">01</p><h2>The queue grows in waves</h2></div>
          <p>Ten requests fit in the room. The next ten wait roughly 500ms for the first wave to release its connections.</p>
        </div>
        <div className="chart" role="img" aria-label="Measured drain time increases with request burst size">
          {requestCounts.map((result) => {
            const predicted = Math.ceil(result.count / 10) * 500;
            return (
              <div className="chartRow" key={result.count}>
                <strong>{result.count}<small>requests</small></strong>
                <div className="track">
                  <div className="measured" style={{ width: `${Math.max(4, result.workloadMs / maxDrain * 100)}%` }}>
                    <span>{seconds(result.workloadMs)}</span>
                  </div>
                  <i style={{ left: `${predicted / maxDrain * 100}%` }} title={`Prediction: ${predicted}ms`} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="legend"><span><i className="legendMeasured" /> measured drain time</span><span><i className="legendPredicted" /> simple prediction</span></div>
      </section>

      <section className="split">
        <article className="card learningCard">
          <p className="sectionNumber">02</p>
          <h2>What we learned</h2>
          <ol>
            <li><strong>Up to 10:</strong> requests run together in one wave.</li>
            <li><strong>Above 10:</strong> extra requests wait in the Node pool.</li>
            <li><strong>At 80:</strong> 70 requests waited and the burst took about four seconds.</li>
          </ol>
          <div className="formula"><span>rough drain time</span><strong>⌈ requests ÷ 10 ⌉ × 500ms</strong></div>
        </article>

        <article className="card distinguishCard">
          <p className="sectionNumber">03</p>
          <h2>Two slowdowns, different clues</h2>
          {slowSql && blockedLoop ? (
            <div className="compare">
              <div><span>Slow SQL</span><strong>{seconds(slowSql.fastP95Ms ?? 0)}</strong><small>fast SQL p95</small><b>{seconds(slowSql.healthP95Ms ?? 0)} health</b></div>
              <div><span>Blocked loop</span><strong>{seconds(blockedLoop.fastP95Ms ?? 0)}</strong><small>fast SQL p95</small><b>{seconds(blockedLoop.healthP95Ms ?? 0)} health</b></div>
            </div>
          ) : <p>Run the first lab suite to add this comparison.</p>}
          <p className="clue">If health is fast while SQL is slow, look at the database path. If health also freezes, look at the Node event loop.</p>
        </article>
      </section>

      {eventLoop && (
        <section className="card loopCard">
          <div className="sectionHeading">
            <div><p className="sectionNumber">04</p><h2>One bad request delays the other nine</h2></div>
            <p>A CPU-heavy callback occupied the only JavaScript thread. Nine fast requests reached the machine, but Node could not invoke their handlers until that callback finished.</p>
          </div>
          <div className="loopTimeline" aria-label={`${eventLoop.delayBeforeHandlerP95Ms} milliseconds waiting for Node, followed by ${eventLoop.victimHandlerP95Ms} milliseconds in the handler`}>
            <div className="cpuLane"><strong>bad request</strong><span>JavaScript CPU work · {seconds(eventLoop.blockerMs)}</span></div>
            <div className="victimLane"><strong>9 normal requests</strong><span className="blockedSegment">cannot enter handler · {seconds(eventLoop.delayBeforeHandlerP95Ms)}</span><span className="workSegment">handler + SQL · {seconds(eventLoop.victimHandlerP95Ms)}</span></div>
          </div>
          <div className="loopFacts">
            <Metric value={seconds(eventLoop.baselineP95Ms)} label="normal p95" note="without blocker" />
            <Metric value={seconds(eventLoop.victimP95Ms)} label="victim p95" note="seen by clients" />
            <Metric value={seconds(eventLoop.victimDbRoundTripP95Ms)} label="database p95" note="after handler ran" />
            <Metric value={`${eventLoop.maxServerActiveDuringBlock}`} label="active DB slots" note={`${eventLoop.maxServerIdleDuringBlock} sampled idle`} />
          </div>
          <p className="loopLesson"><strong>PgBouncer cannot help:</strong> it received no query while JavaScript was blocked. Its connections were available but unreachable from this Node process.</p>
        </section>
      )}

      {arrivalRates.length > 0 && (
        <section className="card rateCard">
          <div className="sectionHeading">
            <div><p className="sectionNumber">05</p><h2>Arrival rate finds the limit</h2></div>
            <p>All cases sent 80 requests. Below 20 requests/second, connections became free as quickly as work arrived. Above it, waiting accumulated.</p>
          </div>
          <div className="capacityRule"><span>predicted service line</span><strong>20 requests / second</strong></div>
          <div className="rateGrid">
            {arrivalRates.map((result) => {
              const isBurst = result.rps === 0;
              const state = isBurst ? "burst" : result.rps > 20 ? "overload" : result.rps === 20 ? "boundary" : "steady";
              return (
                <div className={`rateItem ${state}`} key={result.name}>
                  <span>{isBurst ? "all at once" : `${result.rps} req/s`}</span>
                  <strong>{seconds(result.requestP95Ms)}</strong>
                  <small>request p95</small>
                  <dl>
                    <div><dt>acquire</dt><dd>{seconds(result.acquireP95Ms)}</dd></div>
                    <div><dt>peak queue</dt><dd>{result.peakNodeWaiting}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
          <p className="rateLesson"><strong>The clue:</strong> database time stayed near 500ms. At 30 req/s, the additional 1.22s appeared while acquiring a connection.</p>
        </section>
      )}

      <footer><span>Connection Queue Lab</span><p>Refresh after a new experiment to load the latest saved JSON.</p></footer>
    </main>
  );
}
