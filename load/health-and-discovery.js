import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:43121';

export const options = {
  vus: 10,
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const health = http.get(`${BASE}/health`);
  check(health, { 'health is 200': (r) => r.status === 200 });

  const login = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: 'alice@example.com', password: 'ChangeMe123!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(login, { 'login is 200': (r) => r.status === 200 });
  const token = login.json('accessToken');
  if (token) {
    const feed = http.get(`${BASE}/api/v1/discovery/feed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check(feed, { 'feed is 200': (r) => r.status === 200 });
  }
  sleep(1);
}
