import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = "AIzaSyDvSfslIQy7-IgLFr0Dywy_yOYzmay8ikI";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

try {
  const result = await model.generateContent("Hello, what is 2+2?");
  console.log("SUCCESS - API is working");
  console.log("Response:", result.response.text());
} catch (err: any) {
  console.log("ERROR:", err.message);
  if (err.status) {
    console.log("Status:", err.status);
  }
  if (err.errorDetails) {
    console.log("Details:", JSON.stringify(err.errorDetails, null, 2));
  }
}
