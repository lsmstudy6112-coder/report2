# Browser TFTP Loopback

브라우저에서 파일을 드래그 앤 드롭하면 Node.js가 UDP TFTP 패킷으로 변환해서 127.0.0.1의 TFTP 서버와 통신하는 예제입니다.

## 실행

```bash
npm install
npm run tftp-server
```

새 터미널:

```bash
npm start
```

브라우저에서 접속:

```text
http://127.0.0.1:3000
```

## 구조

- `public/index.html`: 브라우저 UI, 드래그 앤 드롭, 다운로드 버튼, 로그 모니터링
- `server.js`: 브라우저 HTTP 요청을 UDP TFTP RRQ/WRQ로 변환하는 중계 서버
- `udp-tftp-server.js`: 실습용 로컬 TFTP 서버
- `tftp-root/`: TFTP 서버의 파일 저장 폴더

## 포트

- Browser UI: `127.0.0.1:3000`
- TFTP UDP: `127.0.0.1:6969`

실제 TFTP 기본 포트는 UDP 69번이지만, 실습 환경에서는 관리자 권한 문제가 생길 수 있어서 6969번을 사용했습니다.
