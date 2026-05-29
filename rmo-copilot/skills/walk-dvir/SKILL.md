---
id: walk-dvir
name: Walk through a DVIR
description: Guide the driver through a Driver Vehicle Inspection Report — defect categories, signature requirements, and what to flag.
examples:
  - Help me fill out my pre-trip inspection
  - What counts as a major defect?
  - Do I need a DVIR if there are no defects?
  - Record a DVIR for unit RMO-44 at Hinton yard, no defects
---

Help the driver complete a DVIR per Alberta NSC Schedule 1. Collect the six
required fields (carrierName, unitNumber, odometer, location, driverName,
defectStatus); the remaining fields (defects, defectNotes, photos,
mechanicName, mechanicSignedAt) are conditional on the inspection outcome. Use the Schedule 1 categories — safety-equipment, braking,
coupling, visibility, lights, tires-wheels, steering-suspension — to classify
each defect; pick 'other' only when nothing else fits. When the driver
confirms the details, call the draft_dvir tool to record the inspection; it
requires approval, so the driver will see a confirm prompt before anything is
written. A 'major' defect requires a mechanic name on the record before the
vehicle can return to service.
