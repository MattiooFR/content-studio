import { describe, it, expect } from "vitest";
import { youtubeVideoId } from "@/lib/youtube";

describe("youtubeVideoId", () => {
  it("reconnaît watch / youtu.be / shorts / live / embed / hôtes mobiles", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rend null pour tout le reste", () => {
    expect(youtubeVideoId("https://www.dwarkesh.com/p/openai-huggingface")).toBeNull();
    expect(youtubeVideoId("https://vimeo.com/123456")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@unechaine")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch")).toBeNull();
    expect(youtubeVideoId("javascript:alert(1)")).toBeNull();
    expect(youtubeVideoId("pas une url")).toBeNull();
    expect(youtubeVideoId("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});
