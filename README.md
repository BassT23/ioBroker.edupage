
# ioBroker EduPage Adapter (edupage)

Fetch timetable data from EduPage directly into ioBroker.

> **Status:** Early development (0.0.x) – already functional and tested.

---

## Features

- Native EduPage login (same flow as browser)
- Admin UI configuration (jsonConfig)
- Automatic school detection from base URL
- Day or full week timetable view
- Periodic sync with safe backoff handling
- Stores data cleanly in ioBroker states
- Detects and reports EduPage captcha challenges

---

## Installation

### From GitHub (local dev)

```
cd /opt/iobroker
iobroker add https://github.com/BassT23/iobroker.edupage.git
```

### npm release planned (not yet published)

## Configuration
Open ioBroker Admin → Instances → edupage → settings

## Required:

Base URL
https://myschool.edupage.org

Username / Password

### Optional:

Refresh interval (minutes)

Max lessons per day

Week view (otherwise today + tomorrow only)

### Captcha handling (important)
EduPage may require a captcha after suspicious activity.

In this case the adapter:

stops syncing automatically

logs a clear warning

prints the captcha URL into the log

Solve the captcha once in the browser and restart the adapter.

## States
Created under:

edupage.0.meta.*
edupage.0.today.*
edupage.0.tomorrow.*
edupage.0.next.*
(State structure may evolve during 0.0.x.)

Requirements
Node.js >= 20

Current ioBroker js-controller & admin

## Changelog
### 0.0.1
Initial alpha release

### 0.0.2
Fully working login flow
Timetable fetch via official EduPage endpoints
Week view support
Captcha detection & safe backoff
Stability and config fixes

### 0.0.3
working on it

## License
[MIT License. See LICENSE.](https://github.com/BassT23/ioBroker.edupage/tree/main?tab=MIT-1-ov-file#)
