const OPENCODE_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const OPENCODE_MODELS_PRIORITY = [
  "minimax-m2.5-free",
  "big-pickle",
  "gpt-5-nano",
];

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function buildPrompt({ repoUrl, track, metrics, repoMetadata }) {
  const commitPreview = (metrics.commits || [])
    .slice(-5)
    .map((commit) => `- ${commit.author_time_iso}: ${commit.subject}`)
    .join("\n");

  return [
    "You are producing a short, practical hackathon repo analysis for organizers.",
    "Write 5-8 concise bullet points.",
    "Focus on what the project appears to be, whether the commit history looks hackathon-authentic, what the repo activity suggests, and any review caveats.",
    "Do not mention that you are an AI model.",
    "Do not use markdown headers.",
    "",
    `Repo URL: ${repoUrl}`,
    `Chosen Track: ${track || "Unknown"}`,
    `Repository Name: ${repoMetadata?.full_name || "Unknown"}`,
    `Description: ${repoMetadata?.description || "None"}`,
    `Default Branch: ${repoMetadata?.default_branch || "Unknown"}`,
    `Primary Language: ${repoMetadata?.language || "Unknown"}`,
    `Stars: ${repoMetadata?.stargazers_count ?? 0}`,
    "",
    "Metrics:",
    JSON.stringify({
      summary: metrics.summary,
      flags: metrics.flags,
      time_distribution: metrics.time_distribution,
    }, null, 2),
    "",
    "Recent commit subjects:",
    commitPreview || "- No commits found",
    "",
    "Return plain markdown bullet points only.",
  ].join("\n");
}

async function callOpenCode(model, prompt) {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing environment variable: OPENCODE_API_KEY");
  }

  const response = await fetch(OPENCODE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode API ${response.status}: ${rawBody}`);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_error) {
    throw new Error(`OpenCode API returned non-JSON body: ${rawBody}`);
  }
  const text = extractTextContent(payload?.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error("OpenCode API returned empty content");
  }

  return text;
}

async function generateAiSummary(input) {
  const prompt = buildPrompt(input);
  const errors = [];

  for (const model of OPENCODE_MODELS_PRIORITY) {
    try {
      const text = await callOpenCode(model, prompt);
      return {
        model,
        text,
        generated_at: new Date().toISOString(),
      };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

module.exports = {
  generateAiSummary,
};
