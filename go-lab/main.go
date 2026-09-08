package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const (
	defaultCPUMilliseconds = 2000
	defaultStartDelay      = 150
	maximumPoolSize        = 10
)

type server struct {
	db *sql.DB
}

type fastResponse struct {
	OK            bool    `json:"ok"`
	Runtime       string  `json:"runtime"`
	GoMaxProcs    int     `json:"goMaxProcs"`
	AcquireMS     float64 `json:"acquire_ms"`
	DBRoundTripMS float64 `json:"db_round_trip_ms"`
	HandlerMS     float64 `json:"handler_ms"`
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func integerQuery(request *http.Request, name string, fallback int) (int, error) {
	value := request.URL.Query().Get(name)
	if value == "" {
		return fallback, nil
	}
	return strconv.Atoi(value)
}

// burnCPU intentionally performs synchronous work. Go may preempt this goroutine.
func burnCPU(milliseconds int) {
	deadline := time.Now().Add(time.Duration(milliseconds) * time.Millisecond)
	var value uint64
	for time.Now().Before(deadline) {
		value = value*1664525 + 1013904223
	}
	runtime.KeepAlive(value)
}

func (application *server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":         true,
		"runtime":    "go",
		"goMaxProcs": runtime.GOMAXPROCS(0),
	})
}

func (application *server) fast(response http.ResponseWriter, request *http.Request) {
	handlerStarted := time.Now()
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()

	acquiring := time.Now()
	connection, err := application.db.Conn(ctx)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	defer connection.Close()
	acquireMS := float64(time.Since(acquiring).Microseconds()) / 1000

	querying := time.Now()
	var value int
	if err := connection.QueryRowContext(ctx, "SELECT 1").Scan(&value); err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	dbRoundTripMS := float64(time.Since(querying).Microseconds()) / 1000

	writeJSON(response, http.StatusOK, fastResponse{
		OK:            value == 1,
		Runtime:       "go",
		GoMaxProcs:    runtime.GOMAXPROCS(0),
		AcquireMS:     acquireMS,
		DBRoundTripMS: dbRoundTripMS,
		HandlerMS:     float64(time.Since(handlerStarted).Microseconds()) / 1000,
	})
}

func (application *server) scheduleCPU(response http.ResponseWriter, request *http.Request) {
	milliseconds, err := integerQuery(request, "ms", defaultCPUMilliseconds)
	if err != nil || milliseconds < 0 || milliseconds > 5000 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "ms must be between 0 and 5000"})
		return
	}
	delayMS, err := integerQuery(request, "delay_ms", defaultStartDelay)
	if err != nil || delayMS < 50 || delayMS > 1000 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "delay_ms must be between 50 and 1000"})
		return
	}
	count, err := integerQuery(request, "count", 1)
	if err != nil || count < 1 || count > 8 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "count must be between 1 and 8"})
		return
	}

	// Each CPU task is a goroutine. The Go scheduler can preempt it so other handlers get turns.
	go func() {
		time.Sleep(time.Duration(delayMS) * time.Millisecond)
		for range count {
			go burnCPU(milliseconds)
		}
	}()

	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":            true,
		"blockForMs":    milliseconds,
		"scheduledInMs": delayMS,
		"cpuTasks":      count,
		"goMaxProcs":    runtime.GOMAXPROCS(0),
	})
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://lab:lab-local-only@127.0.0.1:56439/lab?sslmode=disable&application_name=go-queue-lab"
	}
	database, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatal(err)
	}
	database.SetMaxOpenConns(maximumPoolSize)
	database.SetMaxIdleConns(maximumPoolSize)
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := database.PingContext(ctx); err != nil {
		log.Fatalf("connect through PgBouncer: %v", err)
	}

	application := &server{db: database}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", application.health)
	mux.HandleFunc("GET /fast", application.fast)
	mux.HandleFunc("GET /cpu-scheduled", application.scheduleCPU)

	log.Printf("Go lab listening on 3000 with GOMAXPROCS=%d", runtime.GOMAXPROCS(0))
	httpServer := &http.Server{
		Addr:              ":3000",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(fmt.Errorf("serve HTTP: %w", err))
	}
}
