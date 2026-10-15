# ai-camera
<!-- impeccable:product-schema 1 -->

## Platform
web

## Product Purpose
Detect and classify people from a browser camera, RDK X5 MIPI camera, or still image. Store per-person detection records with timestamps and camera IDs in SQL and display them in ai-camera's own dashboard.

## Operating Context
The user runs the Python MIPI bridge on an RDK X5 Linux board and Vite on the local network. The working camera configuration is 1280×720, 30 fps, JPEG quality 55. Camera restart and long-running stability must be preserved.

## Capabilities and Constraints
React/Vite/TypeScript, browser-side YOLO and Gemini classification. Student and medical attire modes. TiDB/MySQL is the requested persistence option. Database credentials stay on the server. ai-camera and MurataWeb are separate projects and databases. MurataWeb is a reference for data views only: today's totals, hourly/daily charts, date and camera filters, daily drill-down, and paginated event tables. No line-crossing detector currently exists in ai-camera; do not invent IN/OUT events. A track is not a globally identified person.

## Evidence on Hand
User confirmed per-person records, camera ID, and displaying them in ai-camera. Reference: /Users/parpaploy/Downloads/MurataWeb-main. Live TiDB credentials have not been supplied. Existing dark teal application styles remain the visual system; data view organization follows the requested reference.
