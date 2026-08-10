# Demo capture evidence

`partmode-contributor-demo.mp4` and `partmode-contributor-demo.gif` are an
18-second capture assembled from verified browser states of public source
snapshot `8db0b80417a494e5b3073c25fc02e0c34e171caa` on 2026-08-10.

The capture ran the repository locally at `http://127.0.0.1:4401`. It did not
use the separately deployed PartMode site. The flow used:

1. the editable Starter plate template;
2. a human width change from 40 mm to 52 mm, committed as revision 1;
3. a real `partmode.cad.agent/v1` loopback session in `preview-required` mode;
4. a detached, exact preview changing `hole_dia` from 8 mm to 18 mm;
5. the visible human approval dialog;
6. OpenCascade kernel and renderer settlement at revision 2; and
7. export of one named STEP body in millimetres.

No test-only pairing helper or prerecorded agent transcript was used. The
social preview uses the verified exact-preview frame from the same capture.
