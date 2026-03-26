export function levelQuizRequest() {
  http.get(
    `${BASE_URL}/api/vocab-quiz/${LEVEL_SLUG}`,
    { headers }
  );
}


export function finalizeLevelQuiz() {
  http.post(
    `${BASE_URL}/api/quiz/grind/finalize`,
    JSON.stringify(payload),
    { headers }
  );
}