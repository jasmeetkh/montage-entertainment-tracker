import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.post("/api/recommendations", async (req, res) => {
    try {
      const { userList } = req.body;
      
      const prompt = `Based on the user's entertainment list below, provide 5 personalized recommendations for movies, shows, or anime.
      
      User List:
      ${JSON.stringify(userList)}
      
      Output exactly 5 recommendations in JSON format based on the provided schema.`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: "You are an entertainment recommendation expert. Analyze user patterns in genres, ratings, and statuses to suggest new things they would love. Provide specific reasons for each recommendation.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                type: { type: Type.STRING, enum: ["movie", "show", "anime"] },
                reason: { type: Type.STRING },
                matchScore: { type: Type.NUMBER }
              },
              required: ["title", "type", "reason", "matchScore"]
            }
          }
        }
      });

      const text = response.text || "[]";
      const recommendations = JSON.parse(text);
      const apiKey = process.env.TMDB_API_KEY;

      if (!apiKey) {
        return res.json(recommendations);
      }

      const enriched = await Promise.all(recommendations.map(async (rec: any) => {
        try {
          const searchQuery = encodeURIComponent(rec.title);
          const [searchRes, genreMap] = await Promise.all([
            fetch(
              `https://api.themoviedb.org/3/search/multi?query=${searchQuery}&api_key=${apiKey}&include_adult=false`
            ),
            getGenreMap(apiKey)
          ]);
          const searchData = await searchRes.json();
          const bestMatch = searchData.results?.[0];
          
          if (bestMatch) {
            return {
              ...rec,
              imageUrl: bestMatch.poster_path 
                ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}` 
                : undefined,
              tmdbId: bestMatch.id,
              tmdbType: bestMatch.media_type,
              genres: (bestMatch.genre_ids || []).map((id: number) => genreMap[id]).filter(Boolean)
            };
          }
        } catch (e) {
          console.error("Enrichment failed for", rec.title, e);
        }
        return rec;
      }));

      res.json(enriched);
    } catch (error: any) {
      console.error("Gemini Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const getGenreMap = async (apiKey: string) => {
    try {
      const [movieGenres, tvGenres] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/genre/movie/list?api_key=${apiKey}`).then(r => r.json()),
        fetch(`https://api.themoviedb.org/3/genre/tv/list?api_key=${apiKey}`).then(r => r.json())
      ]);
      const allGenres = [...(movieGenres.genres || []), ...(tvGenres.genres || [])];
      return Object.fromEntries(allGenres.map(g => [g.id, g.name]));
    } catch (e) {
      return {};
    }
  };

  app.get("/api/trending", async (req, res) => {
    try {
      const apiKey = process.env.TMDB_API_KEY;
      const { genreId } = req.query;

      if (!apiKey) {
        return res.status(500).json({ error: "TMDB API key not configured" });
      }

      let url = `https://api.themoviedb.org/3/trending/all/day?api_key=${apiKey}`;
      
      if (genreId && genreId !== 'all') {
        url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&with_genres=${genreId}&sort_by=popularity.desc`;
      }

      const [response, genreMap] = await Promise.all([
        fetch(url),
        getGenreMap(apiKey)
      ]);
      const data = await response.json();
      
      const results = (data.results || [])
        .filter((item: any) => item.media_type === "movie" || item.media_type === "tv" || !item.media_type)
        .map((item: any) => {
          const isAnimation = item.genre_ids?.includes(16);
          const isJapanese = item.origin_country?.includes("JP") || item.original_language === "ja";
          
          let mediaType = item.media_type || (item.title ? "movie" : "tv");
          let type = mediaType === "movie" ? "movie" : "show";
          if (isAnimation && isJapanese) {
            type = "anime";
          }

          return {
            id: item.id,
            title: item.title || item.name,
            type,
            imageUrl: item.poster_path 
              ? `https://image.tmdb.org/t/p/w500${item.poster_path}` 
              : null,
            releaseDate: item.release_date || item.first_air_date,
            rating: item.vote_average,
            tmdbId: item.id,
            tmdbType: mediaType,
            genres: (item.genre_ids || []).map((id: number) => genreMap[id]).filter(Boolean)
          };
        });

      res.json(results);
    } catch (error: any) {
      console.error("TMDB Trending Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/genres", async (req, res) => {
    try {
      const apiKey = process.env.TMDB_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "TMDB API key not configured" });

      const [movieGenres, tvGenres] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/genre/movie/list?api_key=${apiKey}`).then(r => r.json()),
        fetch(`https://api.themoviedb.org/3/genre/tv/list?api_key=${apiKey}`).then(r => r.json())
      ]);

      // Merge and deduplicate
      const allGenres = [...(movieGenres.genres || []), ...(tvGenres.genres || [])];
      const uniqueGenres = Array.from(new Map(allGenres.map(item => [item.id, item])).values())
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json(uniqueGenres);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/search", async (req, res) => {
    try {
      const { query } = req.query;
      const apiKey = process.env.TMDB_API_KEY;

      if (!apiKey) {
        return res.status(500).json({ error: "TMDB API key not configured" });
      }

      if (!query) {
        return res.json([]);
      }

      const [response, genreMap] = await Promise.all([
        fetch(
          `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(
            String(query)
          )}&api_key=${apiKey}&include_adult=false`
        ),
        getGenreMap(apiKey)
      ]);

      const data = await response.json();
      
      // Filter and map results to a cleaner format
      const results = (data.results || [])
        .filter((item: any) => item.media_type === "movie" || item.media_type === "tv")
        .slice(0, 5)
        .map((item: any) => {
          // Detect if it's anime
          const isAnimation = item.genre_ids?.includes(16);
          const isJapanese = item.origin_country?.includes("JP") || item.original_language === "ja";
          
          let type = item.media_type === "movie" ? "movie" : "show";
          if (isAnimation && isJapanese) {
            type = "anime";
          }

          return {
            id: item.id,
            title: item.title || item.name,
            type,
            imageUrl: item.poster_path 
              ? `https://image.tmdb.org/t/p/w500${item.poster_path}` 
              : null,
            releaseDate: item.release_date || item.first_air_date,
            rating: item.vote_average,
            genres: (item.genre_ids || []).map((id: number) => genreMap[id]).filter(Boolean)
          };
        });

      res.json(results);
    } catch (error: any) {
      console.error("TMDB Search Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
