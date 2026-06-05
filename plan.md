flowchart TD
    subgraph Errors["🐞 Errors"]
      E1[Frontend error list]
    end
    subgraph Perf["📊 Performance"]
      P1["5 web-vital widgets<br/>LCP · INP · CLS · FCP · TTFB"]
      P2[Percentile switcher p75/p90/p95]
      P3[Breakdown by page]
    end
    subgraph Pages["📄 Pages"]
      PG1["URL list"]
      PG2["visits · errors · avg time spent<br/>scroll depth · web vitals (per page)"]
    end
    subgraph Sessions["👤 Sessions"]
      S1["Session row<br/>user/email/anon id · signals (rage/dead/slow)<br/>errors · web vitals · #pages · scroll<br/>duration + online/offline · app version"]
      S2[["Detail sidebar/modal<br/>timezone · browser · memory<br/>org · screen size · referrer"]]
    end
    subgraph Replay["▶️  Session Replay (modal)"]
      R1[rrweb player]
      R2["Right: events timeline<br/>(timestamp-synced to playhead)"]
      R3["Bottom: network gantt<br/>+ breadcrumbs"]
    end

    P3 -->|drill into a slow route| PG1
    PG2 -->|errors count| Errors
    PG2 -->|sessions on this URL| Sessions
    S1 -->|errors count| Errors
    S1 -->|pages visited| Pages
    S1 -->|watch replay| Replay
    S1 -.->|expand row| S2
